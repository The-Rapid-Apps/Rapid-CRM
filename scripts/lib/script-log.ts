/**
 * Structured logging for operational scripts, in the same JSON shape the app's
 * server logger emits, so `logs/*.log` can be grepped with one pattern
 * regardless of which process wrote the line.
 */
function emit(
  stream: "log" | "error",
  level: "info" | "error",
  scope: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  const line = JSON.stringify({
    level,
    msg: `[${scope}] ${message}`,
    ts: new Date().toISOString(),
    ...extra,
  });
  if (stream === "error") console.error(line);
  else console.log(line);
}

export function logJson(
  scope: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  emit("log", "info", scope, message, extra);
}

export function logJsonError(
  scope: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  emit("error", "error", scope, message, extra);
}
