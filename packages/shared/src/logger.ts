/** 日志级别 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 日志输出端口：默认 console；测试可注入内存实现断言 */
export interface LogSink {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ServiceLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const CONSOLE_SINK: LogSink = {
  debug: (...args) => console.debug(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

/**
 * 分级日志工厂（服务侧）：scope 作为前缀，便于按模块过滤与聚合。
 * debug 默认仅在非生产环境输出（高频日志不落盘）；sink 可注入以便测试断言。
 */
export function createServiceLogger(
  scope: string,
  opts: { sink?: Partial<LogSink>; debugEnabled?: boolean } = {},
): ServiceLogger {
  const sink: LogSink = { ...CONSOLE_SINK, ...opts.sink };
  const debugEnabled = opts.debugEnabled ?? process.env["NODE_ENV"] !== "production";
  const emit = (level: LogLevel, args: unknown[]): void => {
    sink[level](`[${scope}]`, ...args);
  };
  return {
    debug: (...args) => {
      if (debugEnabled) emit("debug", args);
    },
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
  };
}
