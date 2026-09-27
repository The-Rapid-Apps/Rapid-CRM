import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { upsertTemplate } from "../app/lib/postmark.server";
import {
  RESET_DONE_TEMPLATE_ALIAS,
  RESET_TEMPLATE_ALIAS,
} from "../app/lib/auth/password-reset.shared";

/**
 * Pushes the templates whose source lives in postmark/<alias>/ to Postmark,
 * creating or updating each by alias. Run after editing one, and once on a new
 * Postmark server:
 *
 *   npm run postmark:push-templates
 */
const TEMPLATES = [
  { alias: RESET_TEMPLATE_ALIAS, name: "Dashboard · Password reset link" },
  { alias: RESET_DONE_TEMPLATE_ALIAS, name: "Dashboard · Password changed" },
];

for (const template of TEMPLATES) {
  const dir = path.join(process.cwd(), "postmark", template.alias);
  const result = await upsertTemplate({
    alias: template.alias,
    name: template.name,
    subject: readFileSync(path.join(dir, "subject.txt"), "utf8").trim(),
    htmlBody: readFileSync(path.join(dir, "content.html"), "utf8"),
    textBody: readFileSync(path.join(dir, "content.txt"), "utf8"),
  });
  console.log(`${result.created ? "created" : "updated"} ${template.alias} (template ${result.templateId})`);
}

/* Explicit, so an open handle pulled in by an import (a database or Redis
   client) can never leave this one-shot script hanging after its work. */
process.exit(0);
