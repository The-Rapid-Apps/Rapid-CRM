/**
 * Is Postmark ready to send password-reset mail?
 *
 * Read-only — lists templates and sender signatures, sends nothing. Exists
 * because password reset depends on template ALIASES existing in Postmark, and
 * a typo there would otherwise surface the first time someone forgets their
 * password.
 *
 *   npm run check:postmark
 */
import { env } from "../app/lib/env.server";
import {
  listDomains,
  listSenderSignatures,
  listTemplates,
} from "../app/lib/postmark.server";
import { AUTH_MESSAGE_STREAM } from "../app/lib/mail-sender.server";
import {
  RESET_DONE_TEMPLATE_ALIAS,
  RESET_TEMPLATE_ALIAS,
} from "../app/lib/auth/password-reset.shared";

let ok = true;

if (!env.POSTMARK_SERVER_TOKEN) {
  console.log("✗ POSTMARK_SERVER_TOKEN is not set — reset links are logged, not emailed.");
  process.exit(1);
}
console.log("✓ POSTMARK_SERVER_TOKEN is set");
console.log(`  auth mail sends on stream: ${AUTH_MESSAGE_STREAM}`);

try {
  const templates = await listTemplates();
  const required = [
    RESET_TEMPLATE_ALIAS,
    RESET_DONE_TEMPLATE_ALIAS,
  ];
  const missing: string[] = [];
  for (const alias of required) {
    const match = templates.find((t) => t.alias === alias);
    if (match) {
      console.log(`✓ template "${alias}" found — ${match.name}`);
    } else {
      ok = false;
      missing.push(alias);
      console.log(`✗ NO template with alias "${alias}" on this server.`);
    }
  }
  if (missing.length) {
    console.log("  Aliases that do exist here:");
    for (const t of templates) console.log(`    ${t.alias ?? "(no alias)"}  — ${t.name}`);
  }
} catch (err) {
  ok = false;
  console.log(`✗ could not list templates: ${String(err).slice(0, 160)}`);
}

/* The From address must be a verified signature or on a verified domain, or
   every send fails with a 300-class Postmark error rather than a transport
   one — easy to misread as "the code is broken". */
const from = env.MAIL_FROM_ADDRESS;
console.log(
  `\n  sending as: ${from}${
    process.env.MAIL_FROM_ADDRESS ? "" : "  (default — MAIL_FROM_ADDRESS unset)"
  }`,
);
if (env.POSTMARK_ACCOUNT_TOKEN) {
  try {
    /* Either authorises the send: a confirmed signature for this exact
       address, OR a verified domain covering every address on it. Checking
       only signatures reported a perfectly good no-reply address as broken —
       which is the whole reason a domain gets verified in the first place. */
    const [senders, domains] = await Promise.all([
      listSenderSignatures(),
      listDomains(),
    ]);
    const signature = senders.find(
      (s) => s.email.toLowerCase() === from.toLowerCase(),
    );
    const domainName = from.split("@")[1]?.toLowerCase() ?? "";
    const domain = domains.find((d) => d.name === domainName);
    const domainOk = Boolean(domain?.dkimVerified && domain?.returnPathVerified);

    if (signature?.confirmed) {
      console.log(`✓ "${from}" is a confirmed sender signature`);
    } else if (domainOk) {
      console.log(`✓ "${domainName}" is a verified domain — any address on it can send`);
      if (!signature) {
        console.log(`  (no signature for "${from}" specifically; the domain covers it)`);
      }
    } else {
      ok = false;
      console.log(`✗ "${from}" cannot send: no confirmed signature, and`);
      console.log(`  "${domainName}" is ${domain ? "not fully verified" : "not a domain in this account"}.`);
    }
  } catch (err) {
    console.log(`  (could not check the sender: ${String(err).slice(0, 120)})`);
  }
} else {
  console.log("  (POSTMARK_ACCOUNT_TOKEN unset — cannot verify the sender; a");
  console.log("   verified DOMAIN also works, so this is not necessarily a problem)");
}

console.log(ok ? "\nReady to send." : "\nNot ready — fix the ✗ above.");
process.exit(ok ? 0 : 1);
