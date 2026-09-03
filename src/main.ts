import { loadProxyConfig, type ProxyConfig } from './config';
import { FrpcSession } from './session';
import { StdioBridge } from './stdio-bridge';

const ERROR_PREFIX = '[frp-visitor-stdio]';

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const reportError = (message: string): void => {
    console.error(`${ERROR_PREFIX} ${message}`);
};

export const run = (args: readonly string[] = process.argv.slice(2)): void => {
    let config: ProxyConfig;
    try {
        config = loadProxyConfig(args);
    } catch (error: unknown) {
        reportError(errorMessage(error));
        process.exitCode = 1;
        return;
    }

    const session = new FrpcSession(config.filePath);
    const bridge = new StdioBridge({
        host: config.visitor.bindHost,
        port: config.visitor.bindPort,
    });
    let shuttingDown = false;

    const shutdown = (code: number): void => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        bridge.stop();
        session.release();
        process.exit(code);
    };

    process.once('exit', () => session.release());
    process.once('SIGINT', () => shutdown(130));
    process.once('SIGTERM', () => shutdown(143));
    // SSH sends SIGHUP to ProxyCommand when the session closes.
    process.once('SIGHUP', () => shutdown(129));

    process.stdin.once('end', () => {
        bridge.endInput();
        const shutdownTimer = setTimeout(() => shutdown(0), 2_000);
        shutdownTimer.unref();
    });
    process.stdin.once('error', () => shutdown(1));
    process.stdout.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE') {
            shutdown(0);
            return;
        }
        reportError(`stdout error: ${error.message}`);
        shutdown(1);
    });

    try {
        session.register(message => {
            reportError(message);
            shutdown(1);
        });
        bridge.start(
            error => {
                reportError(error.message);
                shutdown(1);
            },
            () => shutdown(0),
        );
    } catch (error: unknown) {
        reportError(errorMessage(error));
        shutdown(1);
    }
};
