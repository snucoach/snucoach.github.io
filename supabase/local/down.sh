#!/usr/bin/env bash
# 로컬 검증용 Supabase 를 내리고 데이터를 지운다.
set -uo pipefail
cd "$(dirname "$0")"
for p in .run/gateway.pid .run/static.pid; do
  [ -f "$p" ] && kill "$(cat "$p")" 2>/dev/null
  rm -f "$p"
done
[ -f .env ] && docker compose down -v --remove-orphans
rm -f .env
