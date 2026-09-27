/**
 * Shared test preload (`npm test` passes it via --import): env.server.ts
 * snapshots process.env into `env` at import time, so anything a test needs
 * must be set BEFORE any app module is imported. dotenv (loaded by
 * env.server) does not override already-set vars, so this wins.
 *
 * Anything added here has to be set here, not in a test file: ESM hoists
 * imports, so a `process.env.X = ...` at the top of a test runs AFTER the
 * module it was meant to configure has already read its value.
 */
process.env.POSTMARK_SERVER_TOKEN ??= "test-token";
process.env.POSTMARK_MESSAGE_STREAM ??= "outbound";
process.env.APP_URL ??= "https://manage.example.com";
