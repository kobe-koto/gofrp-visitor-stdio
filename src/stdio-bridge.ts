import * as net from 'node:net';

const DEFAULT_RETRIES = 50;
const DEFAULT_RETRY_DELAY_MS = 100;

export type StdioBridgeOptions = {
    host: string;
    port: number;
    retries?: number;
    retryDelayMs?: number;
};

export type BridgeErrorHandler = (error: Error) => void;
export type BridgeCloseHandler = () => void;

const asError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));

export class StdioBridge {
    private readonly options: StdioBridgeOptions;
    private readonly retries: number;
    private readonly retryDelayMs: number;
    private socket: net.Socket | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;

    constructor(options: StdioBridgeOptions) {
        this.options = options;
        this.retries = options.retries ?? DEFAULT_RETRIES;
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    }

    start(onError: BridgeErrorHandler, onClose: BridgeCloseHandler): void {
        this.stopped = false;
        this.connect(this.retries, onError, onClose);
    }

    endInput(): void {
        this.socket?.end();
    }

    stop(): void {
        this.stopped = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }

        const socket = this.socket;
        this.socket = null;
        if (!socket) {
            return;
        }

        process.stdin.unpipe(socket);
        socket.unpipe(process.stdout);
        socket.destroy();
    }

    private connect(
        retriesRemaining: number,
        onError: BridgeErrorHandler,
        onClose: BridgeCloseHandler,
    ): void {
        if (this.stopped) {
            return;
        }

        const socket = new net.Socket();
        this.socket = socket;
        let connected = false;
        let completed = false;

        const handleFailure = (cause?: unknown): void => {
            if (completed) {
                return;
            }
            completed = true;
            socket.destroy();

            if (this.stopped) {
                return;
            }
            if (connected) {
                const message = cause ? asError(cause).message : 'unknown error';
                onError(new Error(`Socket error: ${message}`));
                return;
            }
            if (retriesRemaining <= 0) {
                onError(new Error('Could not connect to frpc visitor port in time.'));
                return;
            }

            this.retryTimer = setTimeout(() => {
                this.retryTimer = null;
                this.connect(retriesRemaining - 1, onError, onClose);
            }, this.retryDelayMs);
        };

        socket.once('connect', () => {
            if (this.stopped) {
                socket.destroy();
                return;
            }
            connected = true;
            process.stdin.pipe(socket);
            socket.pipe(process.stdout);
        });

        socket.once('error', handleFailure);
        socket.once('close', () => {
            if (completed || this.stopped) {
                return;
            }
            if (connected) {
                completed = true;
                onClose();
                return;
            }
            handleFailure(new Error('socket closed before connecting'));
        });

        try {
            socket.connect(this.options.port, this.options.host);
        } catch (error: unknown) {
            handleFailure(error);
        }
    }
}
