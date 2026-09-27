// Production HTTP server for rapi-management.
//
// Replaces `react-router-serve` (`npm run start`) for one reason: pm2 cluster
// mode forks via Node's `cluster` module and therefore needs a real JS entry
// point. The previous pm2 config ran `script: "npm", interpreter: "none"`,
// which can only ever run as a single fork.
//
// Same shape as pixelio's `server.js`, minus the Shopify/Cloudflare specifics
// (Early Hints, noisy-route log filtering) that don't apply to an internal
// dashboard.
import "dotenv/config";

import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";
import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";
import { closeRedis } from "./app/lib/redis.server.ts";

process.env.NODE_ENV = process.env.NODE_ENV ?? "production";

// The cron workers in ecosystem.config.cjs post to this port over loopback, so
// they must see the same PORT.
const PORT = Number(process.env.PORT) || 3000;

const build = await import(
  url.pathToFileURL(path.resolve("build/server/index.js")).href
);

const app = express();
app.disable("x-powered-by");

// nginx terminates TLS and proxies over loopback, so req.protocol/req.ip are
// only meaningful if we trust its X-Forwarded-* headers.
app.set("trust proxy", true);

// Z_SYNC_FLUSH keeps React's streamed shell available to the browser chunk by
// chunk instead of buffering until zlib has a full block.
app.use(compression({ flush: zlib.constants.Z_SYNC_FLUSH }));

// Vite fingerprints everything under assets/, so a URL only ever names one
// version of a file — safe to cache immutably.
app.use(
  "/assets",
  express.static("build/client/assets", { immutable: true, maxAge: "1y" }),
);

// The rest of build/client is public/ copied verbatim: stable URLs, changing
// contents. Keep it short.
app.use(express.static("build/client", { maxAge: "1h" }));

// Mounted with `app.use`, not `app.all("*")`: Express 5 moved to
// path-to-regexp v8, where a bare "*" is no longer a valid path and throws at
// boot. Root-mounted middleware means the same file works on Express 4 and 5.
app.use(createRequestHandler({ build, mode: process.env.NODE_ENV }));

// Bind loopback only — nothing should reach this port except nginx and the
// cron wrapper, and the box has a public IP.
const server = app.listen(PORT, "127.0.0.1", () => {
  const worker = process.env.NODE_APP_INSTANCE ?? "0";
  console.log(`[server] worker ${worker} listening on 127.0.0.1:${PORT}`);
});

// pm2 `reload` sends SIGINT to each worker in turn and waits for it to exit
// before starting its replacement. Closing the server rather than exiting
// immediately is what makes that reload zero-downtime: in-flight requests
// finish, and pm2's kill_timeout is the backstop if one hangs.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    server.close(async (err) => {
      if (err) console.error("[server] error during shutdown:", err);
      await closeRedis();
      process.exit(err ? 1 : 0);
    });
  });
}
