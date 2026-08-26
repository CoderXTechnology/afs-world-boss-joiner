// Minimal leveled logger with timestamps.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function log(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const out = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${line}`;
  if (level === "error" || level === "warn") console.error(out);
  else console.log(out);
}

export function createLogger(scope) {
  return {
    debug: (...args) => log("debug", scope, args),
    info: (...args) => log("info", scope, args),
    warn: (...args) => log("warn", scope, args),
    error: (...args) => log("error", scope, args),
  };
}
