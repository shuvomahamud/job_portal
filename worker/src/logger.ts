type LogLevel = "debug" | "info" | "warn" | "error";

const levelRank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";

function safeMeta(meta?: Record<string, unknown>) {
  if (!meta) return undefined;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    redacted[key] = /secret|token|password|authorization|database_url/i.test(key) ? "[redacted]" : value;
  }
  return redacted;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (levelRank[level] < levelRank[configuredLevel]) return;
  const entry = { ts: new Date().toISOString(), level, message, ...safeMeta(meta) };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
};
