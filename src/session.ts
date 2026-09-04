import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_TIMEOUT_MS = 5_000;
const RELEASE_LOCK_TIMEOUT_MS = 3_000;
const LOCK_RETRY_DELAY_MS = 20;

type TomlLikeObject = Record<string, unknown>;

type SessionState = {
    frpcPid: number;
    sessions: number[];
};

export type FrpcFailureHandler = (message: string) => void;

const isAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
};

const sleepSync = (milliseconds: number): void => {
    Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        milliseconds,
    );
};

const acquireLock = (lockPath: string, timeoutMs: number): void => {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        try {
            writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
            return;
        } catch (error: unknown) {
            const fileError = error as NodeJS.ErrnoException;
            if (fileError.code !== 'EEXIST') {
                throw error;
            }

            let holderPid = Number.NaN;
            try {
                holderPid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
            } catch {
                // The lock may have been removed between the failed create and read.
            }

            if (Number.isInteger(holderPid) && holderPid > 0 && !isAlive(holderPid)) {
                try {
                    unlinkSync(lockPath);
                } catch {
                    // Another process may have removed the stale lock already.
                }
                continue;
            }

            if (Date.now() >= deadline) {
                throw new Error(`timeout waiting for lock: ${lockPath}`);
            }
            sleepSync(LOCK_RETRY_DELAY_MS);
        }
    }
};

const releaseLock = (lockPath: string): void => {
    try {
        unlinkSync(lockPath);
    } catch {
        // The lock may already have been removed during shutdown.
    }
};

const withLock = <T>(
    lockPath: string,
    timeoutMs: number,
    action: () => T,
): T => {
    acquireLock(lockPath, timeoutMs);
    try {
        return action();
    } finally {
        releaseLock(lockPath);
    }
};

const isObject = (value: unknown): value is TomlLikeObject =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0;

const readState = (statePath: string): SessionState | null => {
    try {
        const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
        if (!isObject(parsed)) {
            return null;
        }

        return {
            frpcPid: isPositiveInteger(parsed.frpcPid) ? parsed.frpcPid : -1,
            sessions: Array.isArray(parsed.sessions)
                ? parsed.sessions.filter(isPositiveInteger)
                : [],
        };
    } catch {
        // A missing or partially-written state file is treated as stale state.
        return null;
    }
};

const writeState = (statePath: string, state: SessionState): void => {
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    try {
        writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
        renameSync(temporaryPath, statePath);
    } finally {
        try {
            unlinkSync(temporaryPath);
        } catch {
            // The temporary file was renamed successfully or was never created.
        }
    }
};

const removeState = (statePath: string): void => {
    try {
        unlinkSync(statePath);
    } catch {
        // State may already have been cleaned by another process.
    }
};

const liveSessions = (sessions: number[]): number[] => [
    ...new Set(sessions.filter(pid => pid !== process.pid && isAlive(pid))),
];

const terminate = (pid: number): void => {
    if (!isAlive(pid)) {
        return;
    }
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        // The process may exit between isAlive and kill.
    }
};

export class FrpcSession {
    private readonly configFilePath: string;
    private readonly lockPath: string;
    private readonly statePath: string;
    private frpc: ChildProcess | null = null;
    private frpcPid = -1;
    private registered = false;
    private released = false;
    private ownsFrpc = false;

    constructor(
        configFilePath: string,
        visitorName: string,
    ) {
        this.configFilePath = configFilePath;

        // SHA-256 is available in Node/Bun, has a strong avalanche effect, and
        // avoids adding a native or third-party hashing dependency.
        const sessionId = createHash('sha256')
            .update(`${configFilePath}-${visitorName}`, 'utf8')
            .digest('hex');
        const filePrefix = join(tmpdir(), `frp-visitor-stdio-${sessionId}`);
        this.lockPath = `${filePrefix}.lock`;
        this.statePath = `${filePrefix}.sessions`;
    }

    register(onFailure: FrpcFailureHandler): void {
        try {
            withLock(this.lockPath, LOCK_TIMEOUT_MS, () => {
                const state = readState(this.statePath);
                const activeSessions = state ? liveSessions(state.sessions) : [];

                if (state && isAlive(state.frpcPid)) {
                    if (!activeSessions.includes(process.pid)) {
                        activeSessions.push(process.pid);
                    }
                    writeState(this.statePath, {
                        frpcPid: state.frpcPid,
                        sessions: activeSessions,
                    });
                    this.frpcPid = state.frpcPid;
                    this.registered = true;
                    console.error(`[frp-visitor-stdio] reuse existing frpc (pid ${this.frpcPid})`);
                    return;
                }

                this.startFrpc(onFailure);
                writeState(this.statePath, {
                    frpcPid: this.frpcPid,
                    sessions: [process.pid],
                });
                this.registered = true;
                console.error(`[frp-visitor-stdio] started frpc (pid ${this.frpcPid})`);
            });
        } catch (error: unknown) {
            if (this.ownsFrpc && !this.registered) {
                terminate(this.frpcPid);
            }
            throw error;
        }
    }

    release(): void {
        if (!this.registered || this.released) {
            return;
        }

        try {
            withLock(this.lockPath, RELEASE_LOCK_TIMEOUT_MS, () => {
                const state = readState(this.statePath);
                if (!state) {
                    if (this.ownsFrpc) {
                        terminate(this.frpcPid);
                    }
                    return;
                }

                // Do not alter a newer session state which no longer contains us.
                if (!state.sessions.includes(process.pid)) {
                    return;
                }

                const remainingSessions = liveSessions(state.sessions);
                if (remainingSessions.length > 0) {
                    writeState(this.statePath, {
                        frpcPid: state.frpcPid,
                        sessions: remainingSessions,
                    });
                    return;
                }

                if (state.frpcPid === this.frpcPid) {
                    terminate(state.frpcPid);
                }
                removeState(this.statePath);
            });
            this.released = true;
        } catch {
            // A later session can remove our stale PID; retry from the exit hook if possible.
        }
    }

    private startFrpc(onFailure: FrpcFailureHandler): void {
        const child = spawn('frpc', ['-c', this.configFilePath], {
            stdio: 'ignore',
        });
        this.frpc = child;
        this.frpcPid = child.pid ?? -1;
        if (this.frpcPid <= 0) {
            throw new Error('frpc did not provide a valid process ID');
        }
        this.ownsFrpc = true;

        let failureReported = false;
        const reportFailure = (message: string): void => {
            if (failureReported || this.released) {
                return;
            }
            failureReported = true;
            onFailure(message);
        };

        child.once('error', (error: Error) => {
            reportFailure(`failed to start frpc: ${error.message}`);
        });
        child.once('exit', (code, signal) => {
            if (code === 0 && signal === null) {
                return;
            }
            const status = signal ? `signal ${signal}` : `code ${code}`;
            reportFailure(`frpc exited with ${status}`);
        });
    }
}
