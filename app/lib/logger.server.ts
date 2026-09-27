/**
 * Tiny structured logger. Flex billing depends on being able to see *why* a
 * charge was or wasn't posted, so log lines are the primary observability
 * surface (the audit table is non-load-bearing per spec §1.5).
 */
type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", msg: string, fields?: Fields) {
  const line = { level, msg, ts: new Date().toISOString(), ...fields };
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  out(JSON.stringify(line));
}

export const logger = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
  /** Namespaced child logger — prefixes every message with `[scope]`. */
  scope(scope: string) {
    return {
      info: (msg: string, fields?: Fields) => emit("info", `[${scope}] ${msg}`, fields),
      warn: (msg: string, fields?: Fields) => emit("warn", `[${scope}] ${msg}`, fields),
      error: (msg: string, fields?: Fields) => emit("error", `[${scope}] ${msg}`, fields),
    };
  },
};
