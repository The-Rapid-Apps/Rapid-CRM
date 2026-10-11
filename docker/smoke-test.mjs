// Test the built image against fresh, disposable MySQL/Redis volumes.
// Usage: docker build -t rapid:smoke . && node docker/smoke-test.mjs
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = mkdtempSync(join(tmpdir(), "rapid-container-test-"));
const project = `rapid-test-${randomBytes(4).toString("hex")}`;
const password = randomBytes(32).toString("hex");
const envFile = join(directory, "test.env");
const override = join(directory, "override.yaml");
const environment = {
  RAPID_IMAGE: process.env.RAPID_TEST_IMAGE ?? "rapid:smoke",
  APP_URL: "http://localhost:3000",
  SEED_ADMIN_EMAIL: "container-test@example.com",
  SERVICE_PASSWORD_MYSQL: password,
  SERVICE_PASSWORD_MYSQLROOT: randomBytes(32).toString("hex"),
  SERVICE_PASSWORD_64_ADMIN: password,
  SERVICE_PASSWORD_64_SESSION: randomBytes(32).toString("hex"),
  SERVICE_PASSWORD_64_ENCRYPTION: randomBytes(32).toString("hex"),
  SERVICE_PASSWORD_64_CRON: randomBytes(32).toString("hex"),
};
writeFileSync(envFile, Object.entries(environment).map(([k, v]) => `${k}=${v}`).join("\n"), { mode: 0o600 });
writeFileSync(override, `services:
  rapid:
    pull_policy: never
    ports: ["127.0.0.1::3000"]
  scheduler:
    pull_policy: never
`);
const base = ["compose", "--env-file", envFile, "-p", project, "-f", "compose.yaml", "-f", override];
function compose(...args) {
  const result = spawnSync("docker", [...base, ...args], { encoding: "utf8", timeout: 300_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "Compose failed");
  return result.stdout;
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
try {
  compose("up", "-d", "--wait", "--wait-timeout", "180");
  const address = compose("port", "rapid", "3000").trim();
  const origin = `http://${address}`;
  assert((await fetch(`${origin}/healthz`)).status === 200, "Readiness failed");
  assert((await fetch(`${origin}/login`)).status === 200, "Login page failed");
  const login = await fetch(`${origin}/login`, {
    method: "POST",
    body: new URLSearchParams({ email: environment.SEED_ADMIN_EMAIL, password }),
    redirect: "manual",
  });
  assert(login.status === 302, `Admin sign-in failed: ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert(cookie, "No session cookie");
  const dashboard = await fetch(`${origin}/app`, { headers: { cookie }, redirect: "manual" });
  assert(dashboard.status === 200, `Dashboard failed: ${dashboard.status}`);
  // Verify scheduler-to-web networking and the cron secret in the real image.
  const sync = compose("exec", "-T", "scheduler", "node", "--import", "tsx", "scripts/sync-shopify.ts");
  const summary = sync.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert(Object.values(summary.lanes).every((state) => state === "complete" || state === "unusable"), "Scheduler could not reach the sync routes");
  compose("exec", "-T", "scheduler", "node", "--import", "tsx", "scripts/sync-org-logo-churn.ts");
  compose("exec", "-T", "scheduler", "node", "--import", "tsx", "scripts/sync-live-discount-checks.ts");
  compose("exec", "-T", "scheduler", "node", "--import", "tsx", "scripts/cleanup-api-logs.ts");
  // Recreate against the same volumes to check migration/seed idempotence.
  compose("up", "-d", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "180", "rapid", "scheduler");
  const restartedOrigin = `http://${compose("port", "rapid", "3000").trim()}`;
  assert((await fetch(`${restartedOrigin}/healthz`)).status === 200, "Readiness after restart failed");
  const restartedLogin = await fetch(`${restartedOrigin}/login`, {
    method: "POST",
    body: new URLSearchParams({ email: environment.SEED_ADMIN_EMAIL, password }),
    redirect: "manual",
  });
  assert(restartedLogin.status === 302, "Admin login did not survive restart");
  console.log("Container smoke test passed: fresh migrations, admin login, dashboard, all scheduled jobs, restart.");
} catch (error) {
  console.error(error);
  console.error(compose("logs", "--tail", "100"));
  process.exitCode = 1;
} finally {
  try { compose("down", "--volumes", "--remove-orphans"); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
