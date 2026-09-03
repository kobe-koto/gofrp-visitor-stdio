import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-toml';

const DEFAULT_BIND_HOST = '127.0.0.1';

type TomlTable = Record<string, unknown>;

export type VisitorConfig = {
    name: string;
    bindHost: string;
    bindPort: number;
};

export type ProxyConfig = {
    filePath: string;
    visitor: VisitorConfig;
};

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

const isTomlTable = (value: unknown): value is TomlTable =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const visitorNames = (visitors: TomlTable[]): string[] => visitors
    .map(visitor => visitor.name)
    .filter((name): name is string => typeof name === 'string');

const formatAvailableVisitors = (visitors: TomlTable[]): string => {
    const names = visitorNames(visitors);
    return names.length > 0 ? ` Available visitors: ${names.join(', ')}` : '';
};

const selectVisitor = (
    visitors: TomlTable[],
    requestedName?: string,
): TomlTable => {
    if (requestedName) {
        const visitor = visitors.find(candidate => candidate.name === requestedName);
        if (!visitor) {
            throw new ConfigError(
                `visitor not found: ${requestedName}.${formatAvailableVisitors(visitors)}`,
            );
        }
        return visitor;
    }

    if (visitors.length === 1) {
        const [onlyVisitor] = visitors;
        if (onlyVisitor) {
            return onlyVisitor;
        }
    }

    throw new ConfigError(
        `visitorName is required when config contains multiple visitors.${formatAvailableVisitors(visitors)}`,
    );
};

const readTomlConfig = (configFilePath: string): TomlTable => {
    try {
        return load(readFileSync(configFilePath, 'utf8'));
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ConfigError(`failed to parse TOML config: ${message}`);
    }
};

const parseBindPort = (visitor: TomlTable, visitorName: string): number => {
    const bindPort = visitor.bindPort;
    if (
        typeof bindPort !== 'number' ||
        !Number.isInteger(bindPort) ||
        bindPort < 1 ||
        bindPort > 65535
    ) {
        throw new ConfigError(
            `visitor "${visitorName}" must have a valid bindPort (1-65535)`,
        );
    }
    return bindPort;
};

const parseBindHost = (visitor: TomlTable, visitorName: string): string => {
    const bindAddr = visitor.bindAddr;
    if (bindAddr === undefined) {
        return DEFAULT_BIND_HOST;
    }
    if (typeof bindAddr !== 'string' || bindAddr.trim().length === 0) {
        throw new ConfigError(`visitor "${visitorName}" must have a valid bindAddr`);
    }
    return bindAddr.trim();
};

export const loadProxyConfig = (args: readonly string[]): ProxyConfig => {
    const [configArgument, visitorArgument] = args;
    if (!configArgument) {
        throw new ConfigError('a config file is required');
    }

    const filePath = resolve(configArgument);
    const config = readTomlConfig(filePath);
    const rawVisitors = config.visitors;

    if (!Array.isArray(rawVisitors) || rawVisitors.length === 0) {
        throw new ConfigError(`no visitors found in config: ${filePath}`);
    }
    if (!rawVisitors.every(isTomlTable)) {
        throw new ConfigError(`invalid visitor entry in config: ${filePath}`);
    }

    const visitors = rawVisitors as TomlTable[];
    const requestedName = visitorArgument?.trim() || undefined;
    const selectedVisitor = selectVisitor(visitors, requestedName);
    const rawName = selectedVisitor.name;

    if (typeof rawName !== 'string' || rawName.trim().length === 0) {
        throw new ConfigError('selected visitor must have a non-empty name');
    }

    const name = rawName.trim();
    return {
        filePath,
        visitor: {
            name,
            bindHost: parseBindHost(selectedVisitor, name),
            bindPort: parseBindPort(selectedVisitor, name),
        },
    };
};
