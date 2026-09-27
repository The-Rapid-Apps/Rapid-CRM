# Rapid

[![CI](https://github.com/Rapi-Apps/rapid/actions/workflows/ci.yml/badge.svg)](https://github.com/Rapi-Apps/rapid/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Open-source billing and analytics platform for Shopify apps.**

Rapid is a multi-tenant service that one team runs for all of its Shopify apps.
Each app keeps its own Shopify OAuth and UI and delegates billing to Rapid over a
small HTTP API; Rapid then reconstructs the business picture — MRR, churn,
trials, LTV — from Shopify Partner data.

Built with React Router, Shopify Polaris, Prisma and MySQL.

![Business overview: MRR, subscriptions and churn across every app](./docs/screenshots/overview.png)

<table>
  <tr>
    <td><img src="./docs/screenshots/mrr.png" alt="Monthly recurring revenue report" /></td>
    <td><img src="./docs/screenshots/app-dashboard.png" alt="Per-app dashboard with top plans and uninstall reasons" /></td>
  </tr>
  <tr>
    <td align="center">MRR &amp; ARR report</td>
    <td align="center">Per-app dashboard</td>
  </tr>
</table>

<sub>Screenshots use the fictional demo data from <code>npm run db:seed-demo</code>.</sub>

## Features

- **Billing**
  - Plans, feature entitlements and usage limits per app
  - Subscriptions on native Shopify billing, or on **flex billing** (a $0 recurring
    price plus usage records, so tier changes never trigger Shopify's re-approval screen)
  - Discounts shared across apps, with redemption limits, durations and scheduling
  - Usage-based auto-tiering and a merchant-facing plan picker
- **Analytics**
  - MRR / ARR, MRR movement (new, expansion, contraction, churn, reactivation)
  - Trials, conversions, churn, predicted LTV, installs and uninstalls
  - Reconstructed from Shopify Partner API facts, with daily snapshots for fast reads
  - GA4 / BigQuery traffic-source reports for App Store listings
- **Customers**
  - A 360° view per shop across all your apps
  - Activity feeds, App Store reviews, uninstall reasons and API request logs
- **Identify API** — apps report the shops that use them
- **Team** — invite teammates, admin and member roles, password reset by email

## Quick start

Requires Node (see `.nvmrc`), MySQL 8 and, optionally, Redis.

```bash
git clone https://github.com/Rapi-Apps/rapid.git
cd rapid
cp .env.example .env    # fill in DATABASE_URL and the secrets
npm ci
npm run db:deploy
npm run db:seed         # creates the admin from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
npm run dev
```

Open <http://localhost:5173/login> and sign in as the seeded admin. There is
intentionally no public sign-up page; add teammates from **Team**.

**Want to look around first?** Fill the dashboard with a fictional portfolio —
three demo apps with 18 months of installs, subscriptions, churn and reviews —
instead of connecting a Shopify Partner account:

```bash
npm run db:seed-demo            # REMOVE=1 npm run db:seed-demo to delete it again
```

Don't have MySQL locally? Docker works:

```bash
docker run -d --name rapid-mysql -e MYSQL_ROOT_PASSWORD=rapid \
  -e MYSQL_DATABASE=rapid -p 3306:3306 mysql:8.4
# DATABASE_URL="mysql://root:rapid@127.0.0.1:3306/rapid"
```

## Connecting your apps

1. Sign in and add your app under **Apps**.
2. Add a Shopify Partner connection under **Connections** so analytics can sync.
3. Point your app at Rapid's API — see the [app integration guide](./docs/INTEGRATION.md).

## Production

```bash
npm ci
npm run db:deploy
npm run build
pm2 startOrReload ecosystem.config.cjs --update-env
```

`ecosystem.config.cjs` runs the web server (`server.js`, clustered) and the
scheduled jobs: the Shopify sync lanes, live-discount checks and API-log
retention. Put a reverse proxy in front of `PORT` (default 3000).

## Documentation

- [App integration guide](./docs/INTEGRATION.md) — register installs, subscribe
  merchants, change tiers.
- [Native Shopify billing discounts](./docs/native-discounts-api.md) — for apps
  using Shopify `appSubscriptionCreate` with centrally managed discounts.
- [Shopify analytics](./docs/shopify-analytics.md) — fact synchronization, KPI
  calculation, scheduling and accuracy rules.

Native Shopify billing integrations must use `/api/discounts/*`. The
`/api/flex/*` endpoints belong to the flex-billing engine and should not be
mixed into a native Shopify-managed subscription flow.

## Development

```bash
npm run typecheck
npm test          # needs DATABASE_URL pointing at a disposable test database
npm run build
```

Issues and pull requests are welcome.

## Security

Please report vulnerabilities privately — see [SECURITY.md](./SECURITY.md).
Don't open a public issue for them.

## License

[MIT](./LICENSE) © 2026 Rapid Apps
