type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString();
}

function format(level: LogLevel, message: string, context?: Record<string, unknown>): string {
  const base = `${timestamp()} [${level.toUpperCase()}] ${message}`;
  if (context && Object.keys(context).length > 0) {
    return `${base} ${JSON.stringify(context)}`;
  }
  return base;
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (shouldLog('debug')) console.debug(format('debug', message, context));
  },
  info(message: string, context?: Record<string, unknown>): void {
    if (shouldLog('info')) console.log(format('info', message, context));
  },
  warn(message: string, context?: Record<string, unknown>): void {
    if (shouldLog('warn')) console.warn(format('warn', message, context));
  },
  error(message: string, context?: Record<string, unknown>): void {
    if (shouldLog('error')) console.error(format('error', message, context));
  },
};
