# Security Policy

Rapid handles billing and holds Shopify credentials, so we take security
reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security
problem.**

Report it privately through GitHub instead:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, including:
   - what an attacker could do, and what they would need (an account, an API key, network access…)
   - the affected version or commit
   - steps to reproduce, or a proof of concept
   - any suggested fix

Only the maintainers can see the report. We'll acknowledge it, keep you
updated while we investigate, and credit you in the release notes if you'd
like.

## Supported versions

Security fixes are made on the `main` branch. Please make sure you can
reproduce the issue on the latest `main` before reporting.

## Scope

In scope:

- Authentication and session handling (dashboard login, password reset, team invites)
- Authorization between organizations and apps (one tenant reading or changing another's data)
- The public APIs: `/api/flex/*`, `/api/discounts/*`, `/v1/identify` and the cron endpoints
- Signed merchant billing links, and the Shopify webhook verification
- Storage and handling of credentials (Partner API tokens, app API keys)

Out of scope:

- Vulnerabilities in a deployment's own infrastructure or configuration
- Findings that require an already-compromised server or database
- Reports produced only by automated scanners, without a demonstrated impact
- Denial of service through sheer request volume

## Running Rapid securely

If you deploy Rapid yourself:

- Generate every secret with `openssl rand -hex 32` — production refuses to
  start with the placeholder values from `.env.example`.
- Serve it over HTTPS only, behind a reverse proxy that sets `X-Forwarded-For`.
- Keep `CRON_SECRET` private; it authorizes the scheduled jobs.
- Keep dependencies current (`npm audit`) and apply updates from this repository.
