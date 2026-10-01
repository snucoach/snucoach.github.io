#!/usr/bin/env bash
# 로컬 검증용 Supabase 를 띄운다: DB → 인증 → 마이그레이션 적용 → REST → 게이트웨이 · 정적 서버
# 필요: docker(데몬 실행 중), node, python3, psql
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
RUN="$PWD/.run"
mkdir -p "$RUN"

# 1) 실행마다 새 비밀값 (로컬 전용, 저장소에 올라가지 않음)
node - <<'EOF' > .env
const crypto = require('crypto');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const secret = crypto.randomBytes(32).toString('hex');
const sign = (role) => {
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ role, iss: 'supabase', iat: now, exp: now + 10 * 365 * 86400 });
  return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
};
console.log(`POSTGRES_PASSWORD=${crypto.randomBytes(16).toString('hex')}`);
console.log(`JWT_SECRET=${secret}`);
console.log(`ANON_KEY=${sign('anon')}`);
console.log(`SERVICE_ROLE_KEY=${sign('service_role')}`);
console.log(`TPL_BASE=http://host.docker.internal:8080/supabase/templates`);
EOF
set -a; . ./.env; set +a

# 2) 정적 사이트 서버 (메일 템플릿도 여기서 읽는다)
if ! curl -fsS -o /dev/null http://127.0.0.1:8080/index.html 2>/dev/null; then
  (cd "$ROOT" && exec nohup python3 -m http.server 8080 --bind 0.0.0.0 > "$RUN/static.log" 2>&1) &
  echo $! > "$RUN/static.pid"
fi

# 3) DB · 메일함
docker compose up -d --wait db mail
docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<SQL
alter user authenticator with password '$POSTGRES_PASSWORD';
alter user supabase_auth_admin with password '$POSTGRES_PASSWORD';
alter user postgres with password '$POSTGRES_PASSWORD';
SQL

# 4) 인증 서버 (auth 스키마 마이그레이션을 스스로 실행)
docker compose up -d auth
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:9999/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:9999/health >/dev/null

# 5) 회원 기능 마이그레이션: 클라우드 SQL Editor 와 같은 postgres 역할로 적용
PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
  -f "$ROOT/supabase/migrations/20261001000000_members.sql"

# 6) REST · 게이트웨이
docker compose up -d rest
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3000/ -H "apikey: $ANON_KEY" 2>/dev/null && break; sleep 1; done
if [ -f "$RUN/gateway.pid" ]; then kill "$(cat "$RUN/gateway.pid")" 2>/dev/null || true; fi
nohup node gateway.mjs > "$RUN/gateway.log" 2>&1 & echo $! > "$RUN/gateway.pid"
sleep 1

echo "ready: site http://localhost:8080  api http://localhost:54321  mail http://localhost:8025"
