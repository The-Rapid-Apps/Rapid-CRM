import { randomUUID } from "node:crypto";
import { prisma } from "../db.server";
import { logger } from "../logger.server";

const log = logger.scope("flex-lock");

/** Per-(org, subscription) lock key (spec §4.2). */
export function lockKey(
  organizationId: string,
  subscriptionId: string,
): string {
  return `flex:${organizationId}:${subscriptionId}`;
}

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`Timed out acquiring lock ${key}`);
    this.name = "LockTimeoutError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Acquire the lock, or steal it only if the existing one has expired. The
 * conditional `WHERE ... expiresAt < now` on the upsert makes acquisition
 * atomic: exactly one caller can insert-or-steal at a time.
 */
async function tryAcquire(
  key: string,
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const affected = await prisma.$executeRaw`
    INSERT INTO flex_locks (\`key\`, \`owner\`, \`lockedAt\`, \`expiresAt\`)
    VALUES (${key}, ${owner}, ${now}, ${expiresAt})
    ON DUPLICATE KEY UPDATE
      \`owner\` = IF(\`expiresAt\` < ${now}, ${owner}, \`owner\`),
      \`lockedAt\` = IF(\`expiresAt\` < ${now}, ${now}, \`lockedAt\`),
      \`expiresAt\` = IF(\`expiresAt\` < ${now}, ${expiresAt}, \`expiresAt\`)
  `;
  return affected > 0;
}

async function renew(
  key: string,
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const affected = await prisma.$executeRaw`
    UPDATE flex_locks
    SET \`expiresAt\` = ${expiresAt}
    WHERE \`key\` = ${key} AND \`owner\` = ${owner}
  `;
  return affected > 0;
}

async function release(key: string, owner: string): Promise<void> {
  try {
    await prisma.$executeRaw`
      DELETE FROM flex_locks
      WHERE \`key\` = ${key} AND \`owner\` = ${owner}
    `;
  } catch (err) {
    // Not fatal: an unreleased lock self-expires via its TTL.
    log.error("failed to release lock", { key, err: String(err) });
  }
}

export interface WithLockOptions {
  /** Lock lifetime; auto-expires so a crashed holder can't wedge it. Default 120s. */
  ttlMs?: number;
  /** Max time to wait to acquire before giving up. Default 180s (spec failAfter). */
  waitMs?: number;
  pollMs?: number;
}

/**
 * Run `fn` while holding the lock `key`. Blocks (polling) until acquired or
 * `waitMs` elapses (then throws LockTimeoutError). Always releases in a finally.
 */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: WithLockOptions = {},
): Promise<T> {
  const ttlMs = opts.ttlMs ?? 120_000;
  const waitMs = opts.waitMs ?? 180_000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + waitMs;
  const owner = randomUUID();

  while (!(await tryAcquire(key, owner, ttlMs))) {
    if (Date.now() >= deadline) throw new LockTimeoutError(key);
    await sleep(pollMs);
  }

  const heartbeatMs = Math.max(1_000, Math.floor(ttlMs / 3));
  const heartbeat = setInterval(() => {
    void renew(key, owner, ttlMs)
      .then((held) => {
        if (!held) {
          log.error("lock lease was lost while work was still running", {
            key,
          });
        }
      })
      .catch((err) => {
        log.error("failed to renew lock lease", {
          key,
          err: String(err),
        });
      });
  }, heartbeatMs);
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await release(key, owner);
  }
}
