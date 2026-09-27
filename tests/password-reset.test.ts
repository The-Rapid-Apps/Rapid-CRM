import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  isWellFormedToken,
  MAX_PASSWORD_LENGTH,
  passwordProblem,
  RESET_COOKIE_PATH,
  resetLinkOrigin,
} from "../app/lib/auth/password-reset.shared";

test("a real token has the expected shape; junk never reaches the database", () => {
  for (let i = 0; i < 50; i += 1) {
    assert.equal(isWellFormedToken(randomBytes(32).toString("base64url")), true);
  }
  for (const junk of ["", "short", "a".repeat(44), "a".repeat(42) + "=", "../../etc/passwd", null, undefined]) {
    assert.equal(isWellFormedToken(junk as string), false, String(junk));
  }
});

test("reset links use the configured origin, upgraded to https in production", () => {
  assert.equal(resetLinkOrigin("http://manage.example.com/", true), "https://manage.example.com");
  assert.equal(resetLinkOrigin("http://localhost:3000", true), "http://localhost:3000", "local dev keeps http");
  assert.equal(resetLinkOrigin("http://manage.example.com", false), "http://manage.example.com");
  // Anything after the origin in the setting is dropped, so the path is ours.
  assert.equal(resetLinkOrigin("https://manage.example.com/app?x=1", true), "https://manage.example.com");
});

test("password rules: length floor and ceiling, confirmation, not the email", () => {
  const email = "jordan@example.com";
  assert.match(passwordProblem("short", "short", email)!, /at least/);
  const huge = "x".repeat(MAX_PASSWORD_LENGTH + 1);
  assert.match(passwordProblem(huge, huge, email)!, /at most/);
  assert.match(passwordProblem("correct horse battery", "correct horse batterY", email)!, /match/);
  assert.match(passwordProblem("jordan@example.com", "jordan@example.com", email)!, /email/);
  assert.match(passwordProblem("JordanRocks2026", "JordanRocks2026", email)!, /email/);
  assert.equal(passwordProblem("correct horse battery", "correct horse battery", email), null);
});

/** RFC 6265 §5.1.4 path-match, as a browser applies it. */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith("/")) return true;
  return requestPath[cookiePath.length] === "/";
}

test("the reset cookie reaches the form's data URL, where the save is posted", () => {
  // The bug: the page loaded, but every save reached the server without the token.
  assert.equal(pathMatches("/reset-password", "/reset-password.data"), false);
  for (const path of ["/reset-password", "/reset-password.data"]) {
    assert.equal(pathMatches(RESET_COOKIE_PATH, path), true, `${path} must receive the reset cookie`);
  }
});
