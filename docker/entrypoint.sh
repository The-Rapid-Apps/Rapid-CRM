#!/bin/sh
set -eu

case "${1:-web}" in
  web)
    # Compose waits for MySQL readiness before starting this service.
    # Failed migrations/seed stop deployment instead of serving an old schema.
    npm run db:deploy
    npm run db:seed
    exec node --import tsx ./server.js
    ;;
  scheduler)
    # BusyBox cron reads the root crontab. This service has no public ports.
    exec crond -f -l 8 -L /dev/stdout -c /app/docker/crontabs
    ;;
  *) exec "$@" ;;
esac
