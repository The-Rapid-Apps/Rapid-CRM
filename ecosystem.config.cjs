// pm2 process configuration for rapid.
//
//   pm2 startOrReload ecosystem.config.cjs --update-env
//
// Everything secret (DATABASE_URL, SESSION_SECRET, CREDENTIAL_ENCRYPTION_KEY,
// CRON_SECRET, GA4/BigQuery) comes from `.env`, which the app loads itself via
// `dotenv/config` in app/lib/env.server.ts.
//
// The cron workers below post to the web process over loopback, so they must
// all see the same PORT as the web app.
const PORT = process.env.PORT ?? "3000";
const cwd = __dirname;

/** A run-to-completion cron job: exits after each tick, never clustered. */
function cronJob(name, npmScript, cronRestart, env = {}) {
  return {
    name,
    cwd,
    script: "npm",
    args: `run ${npmScript}`,
    interpreter: "none",
    env: { NODE_ENV: "production", PORT, ...env },
    // ⚠️ Never cluster: N instances means N concurrent runs of the same job.
    instances: 1,
    exec_mode: "fork",
    // autorestart must stay false or pm2 reads each clean exit as a crash and
    // runs the job continuously.
    autorestart: false,
    cron_restart: cronRestart,
    kill_timeout: 30000,
    out_file: `./logs/${name}-out.log`,
    error_file: `./logs/${name}-err.log`,
    merge_logs: true,
    time: true,
  };
}

module.exports = {
  apps: [
    {
      name: "rapid",
      cwd,

      // A real JS entry, not `npm run start`. Cluster mode forks through Node's
      // `cluster` module, which cannot fork a shell script. server.js replaces
      // react-router-serve; see its header.
      script: "./server.js",
      // server.js imports app/lib/redis.server.ts directly (no build step for
      // that file). tsx's --import loader lets plain `node` resolve
      // extensionless TS imports.
      node_args: ["--import", "tsx"],

      env: { NODE_ENV: "production", PORT },

      // Clustering buys event-loop headroom (one CPU-bound report rebuild no
      // longer blocks every other request). Shared caches and locks are
      // Redis-backed (REDIS_URL) so every worker sees the same state; they fall
      // back to per-process behaviour if Redis is unreachable. To run a single
      // process: instances 1, exec_mode "fork".
      instances: 2,
      exec_mode: "cluster",

      autorestart: true,
      // Per worker. Report caches are parsed from large JSON blobs, which
      // spikes memory on a cold read.
      max_memory_restart: "2G",
      // Give an in-flight request time to finish on `pm2 reload`. server.js
      // closes the listener on SIGINT/SIGTERM.
      kill_timeout: 5000,
      min_uptime: "20s",
      max_restarts: 10,
      restart_delay: 2000,

      out_file: "./logs/out.log",
      error_file: "./logs/err.log",
      merge_logs: true,
      time: true,
    },

    // The Shopify sync lanes (app/lib/shopify/sync-lanes.server.ts). Every lane
    // is resumable, so a killed run loses no progress; the script's own 4-minute
    // deadline ends each run inside the 5-minute window.
    cronJob("rapid-sync", "sync:shopify", "*/5 * * * *"),

    // Org-wide logo-churn snapshot writer. Talks to the database directly.
    cronJob("rapid-org-logo-churn", "sync:org-logo-churn", "*/5 * * * *"),

    // Re-checks live Shopify discounts on Partner charges, which feed MRR.
    cronJob("rapid-live-discounts", "sync:live-discounts", "20 * * * *"),

    // API request log retention, weekly (Sunday 03:00).
    cronJob("rapid-cleanup-api-logs", "cleanup:api-logs", "0 3 * * 0", {
      API_LOG_RETENTION_DAYS: "30",
    }),
  ],
};
