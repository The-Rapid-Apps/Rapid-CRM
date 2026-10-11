// No dependencies needed: generate a separate Compose env without touching .env.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const values = {
  APP_URL: "http://localhost:3000",
  SEED_ADMIN_EMAIL: "admin@example.com",
  ...Object.fromEntries(
    ["MYSQL", "MYSQLROOT", "SESSION", "ENCRYPTION", "CRON", "ADMIN"].map((name) => [
      `SERVICE_PASSWORD_${["MYSQL", "MYSQLROOT"].includes(name) ? "" : "64_"}${name}`,
      randomBytes(32).toString("hex"),
    ]),
  ),
};

writeFileSync(
  ".env.compose",
  Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log("Created .env.compose. Set APP_URL and SEED_ADMIN_EMAIL before deploying.");
console.log("Your initial login password is SERVICE_PASSWORD_64_ADMIN in that file.");
