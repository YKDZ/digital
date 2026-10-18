#!/bin/sh
set -eu

uid=$(id -u)
gid=$(id -g)
if [ "$uid" -eq 0 ] || [ "$gid" -eq 0 ]; then
  echo "Compose 部署拒绝 root UID/GID" >&2
  exit 64
fi

case "${DIGITAL_COMPOSE_SERVICE:?}" in
  migrate)
    exec node /migration/dist/cli.js prepare-only
    ;;
  service)
    exec "$@"
    ;;
  *)
    echo "未知 Compose 服务" >&2
    exit 64
    ;;
esac
