// 데이터베이스 권한·보안 규칙 검증 (실제 인증 서버 + REST API 를 직접 호출)
// 실행: ./up.sh 로 스택을 띄운 뒤  node api-tests.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const env = Object.fromEntries(readFileSync(new URL('./.env', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = 'http://localhost:54321';
const ANON = env.ANON_KEY;
const SERVICE = env.SERVICE_ROLE_KEY;

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failed += 1;
}
async function call(path, { method = 'GET', token = ANON, body, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { apikey: ANON, authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
function sql(q) {
  return execFileSync('psql', ['-h', '127.0.0.1', '-p', '54322', '-U', 'postgres', '-d', 'postgres', '-At', '-c', q],
    { env: { ...process.env, PGPASSWORD: env.POSTGRES_PASSWORD } }).toString().trim();
}
const stamp = Date.now();
const mail = (n) => `api-${n}-${stamp}@example.com`;
const PW = 'test1234pw';

async function adminCreate(email, meta) {
  return call('/auth/v1/admin/users', { method: 'POST', token: SERVICE, headers: { apikey: SERVICE },
    body: { email, password: PW, email_confirm: true, user_metadata: meta } });
}
async function login(email, password = PW) {
  const r = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  return r.json.access_token;
}
const fullMeta = { name: '  김학생  ', member_type: '학생', grade: '고2', agree_terms: true, agree_privacy: true, agree_age: true, marketing: true };

// 1) 가입 트리거: 동의 포함 가입 → 프로필 완성 상태로 생성
const a = await adminCreate(mail('a'), fullMeta);
check('관리 API로 회원 A 생성', a.status === 200, a);
const tokA = await login(mail('a'));
let r = await call('/rest/v1/profiles?select=*', { token: tokA });
const pa = r.json[0] || {};
check('A는 본인 프로필 1개만 본다', r.status === 200 && r.json.length === 1, r);
check('이름 앞뒤 공백 제거', pa.name === '김학생', pa.name);
check('회원 구분·학년 저장', pa.member_type === '학생' && pa.grade === '고2', pa);
check('필수 동의 시각 3개 기록', !!(pa.terms_agreed_at && pa.privacy_agreed_at && pa.age_confirmed_at), pa);
check('마케팅 동의와 시각 기록', pa.marketing_opt_in === true && !!pa.marketing_opt_in_at, pa);
check('관리자 아님', pa.is_admin === false, pa.is_admin);

// 2) 이상한 메타데이터 → 값은 버리고 가입은 진행, 동의 없음
const b = await adminCreate(mail('b'), { name: 'x'.repeat(40), member_type: '해커', grade: '대학원', agree_terms: 'yes', marketing: true });
check('잘못된 값이 있어도 가입은 진행', b.status === 200, b);
const tokB = await login(mail('b'));
r = await call('/rest/v1/profiles?select=*', { token: tokB });
const pb = r.json[0] || {};
check('이름은 20자로 잘림', pb.name === 'x'.repeat(20), pb.name);
check('허용되지 않은 회원 구분·학년은 비움', pb.member_type === null && pb.grade === null, pb);
check('"yes" 같은 값은 동의로 인정하지 않음', pb.terms_agreed_at === null && pb.privacy_agreed_at === null && pb.age_confirmed_at === null, pb);
check('필수 동의 없이 마케팅 동의는 기록하지 않음', pb.marketing_opt_in === false && pb.marketing_opt_in_at === null, pb);

// 3) 남의 프로필
r = await call(`/rest/v1/profiles?id=eq.${pb.id}&select=*`, { token: tokA });
check('A는 B 프로필을 못 본다', r.status === 200 && r.json.length === 0, r);
r = await call(`/rest/v1/profiles?id=eq.${pb.id}`, { method: 'PATCH', token: tokA, body: { name: '탈취' }, headers: { prefer: 'return=representation' } });
check('A는 B 프로필을 못 고친다(0행)', r.status === 200 && Array.isArray(r.json) && r.json.length === 0, r);
check('B 이름 그대로', sql(`select name from public.profiles where id='${pb.id}'`) === 'x'.repeat(20));

// 4) 고칠 수 없는 칸
r = await call(`/rest/v1/profiles?id=eq.${pa.id}`, { method: 'PATCH', token: tokA, body: { is_admin: true } });
check('is_admin 셀프 승격 차단', r.status === 401 || r.status === 403, r);
r = await call(`/rest/v1/profiles?id=eq.${pa.id}`, { method: 'PATCH', token: tokA, body: { created_at: '2000-01-01T00:00:00Z' } });
check('created_at 변경 차단', r.status === 401 || r.status === 403, r);
r = await call(`/rest/v1/profiles?id=eq.${pa.id}`, { method: 'PATCH', token: tokA, body: { id: pb.id } });
check('id 변경 차단', r.status === 401 || r.status === 403, r);
r = await call('/rest/v1/profiles', { method: 'POST', token: tokA, body: { id: pa.id, name: '중복' } });
check('프로필 직접 생성 차단', r.status === 401 || r.status === 403, r);
r = await call(`/rest/v1/profiles?id=eq.${pa.id}`, { method: 'DELETE', token: tokA });
check('프로필 직접 삭제 차단', r.status === 401 || r.status === 403, r);

// 5) 동의 시각 조작
const before = pa.terms_agreed_at;
r = await call(`/rest/v1/profiles?id=eq.${pa.id}`, { method: 'PATCH', token: tokA, body: { terms_agreed_at: '2001-01-01T00:00:00Z', privacy_agreed_at: null }, headers: { prefer: 'return=representation' } });
check('기록된 동의 시각은 바꾸거나 지울 수 없다', r.status === 200 && r.json[0].terms_agreed_at === before && r.json[0].privacy_agreed_at === pa.privacy_agreed_at, r);
r = await call(`/rest/v1/profiles?id=eq.${pb.id}`, { method: 'PATCH', token: tokB,
  body: { name: '박학부모', member_type: '학부모', grade: '중3', terms_agreed_at: '2001-01-01T00:00:00Z', privacy_agreed_at: '2001-01-01T00:00:00Z', age_confirmed_at: '2001-01-01T00:00:00Z' },
  headers: { prefer: 'return=representation' } });
const pb2 = (r.json && r.json[0]) || {};
const fresh = (t) => t && Math.abs(Date.now() - Date.parse(t)) < 60_000;
check('가입 마무리: 동의 시각은 클라이언트 값 대신 서버 시각', r.status === 200 && fresh(pb2.terms_agreed_at) && fresh(pb2.privacy_agreed_at) && fresh(pb2.age_confirmed_at), r);
r = await call(`/rest/v1/profiles?id=eq.${pb.id}`, { method: 'PATCH', token: tokB, body: { member_type: '해커' } });
check('허용되지 않은 회원 구분은 거부(400)', r.status === 400, r);

// 6) 마케팅 동의 변경 시각
r = await call(`/rest/v1/profiles?id=eq.${pa.id}`, { method: 'PATCH', token: tokA, body: { name: '김학생2' }, headers: { prefer: 'return=representation' } });
check('마케팅 값을 안 바꾸면 시각 유지', r.json[0].marketing_opt_in_at === pa.marketing_opt_in_at, r.json[0]);
r = await call(`/rest/v1/profiles?id=eq.${pa.id}`, { method: 'PATCH', token: tokA, body: { marketing_opt_in: false, marketing_opt_in_at: '2001-01-01T00:00:00Z' }, headers: { prefer: 'return=representation' } });
check('마케팅 철회 시각은 서버가 기록(직접 쓰기 불가)', r.status === 401 || r.status === 403, r);
r = await call(`/rest/v1/profiles?id=eq.${pa.id}`, { method: 'PATCH', token: tokA, body: { marketing_opt_in: false }, headers: { prefer: 'return=representation' } });
check('마케팅 철회 → 시각 갱신', r.status === 200 && r.json[0].marketing_opt_in === false && r.json[0].marketing_opt_in_at !== pa.marketing_opt_in_at, r);

// 7) 비로그인(anon)
r = await call('/rest/v1/profiles?select=*');
check('비로그인은 프로필 테이블 접근 불가', r.status === 401 || r.status === 403, r);
r = await call('/rest/v1/rpc/delete_my_account', { method: 'POST', body: {} });
check('비로그인은 탈퇴 함수 호출 불가', r.status === 401 || r.status === 403, r);
r = await call('/rest/v1/rpc/admin_list_members', { method: 'POST', body: {} });
check('비로그인은 회원 목록 호출 불가', r.status === 401 || r.status === 403, r);
r = await call('/rest/v1/rpc/ping', { method: 'POST', body: {} });
check('ping 은 비로그인도 호출 가능(데이터 없음)', r.status === 200 && r.json === 'ok', r);
r = await call('/rest/v1/rpc/handle_new_user', { method: 'POST', body: {} });
check('내부 함수는 API 로 노출되지 않음', r.status === 404, r);

// 8) 관리자
r = await call('/rest/v1/rpc/admin_list_members', { method: 'POST', token: tokA, body: {} });
check('일반 회원은 회원 목록 거부', r.status === 401 || r.status === 403, r);
sql(`update public.profiles set is_admin = true where id = '${pa.id}'`);
r = await call('/rest/v1/rpc/admin_list_members', { method: 'POST', token: tokA, body: {} });
const rows = Array.isArray(r.json) ? r.json : [];
const rowB = rows.find((x) => x.id === pb.id) || {};
check('관리자는 회원 목록 조회', r.status === 200 && rows.some((x) => x.id === pa.id) && !!rowB.id, r);
check('목록에 이메일·완료 여부 포함', rowB.email === mail('b') && rowB.profile_completed === true && rowB.provider === 'email', rowB);
r = await call(`/rest/v1/profiles?id=eq.${pb.id}&select=*`, { token: tokA });
check('관리자라도 profiles 테이블 직접 조회는 본인 것만', r.status === 200 && r.json.length === 0, r);

// 9) 탈퇴
r = await call('/rest/v1/rpc/delete_my_account', { method: 'POST', token: tokB, body: {} });
check('B 탈퇴 호출 성공', r.status === 204 || r.status === 200, r);
check('B 계정 삭제', sql(`select count(*) from auth.users where id='${pb.id}'`) === '0');
check('B 프로필 삭제(cascade)', sql(`select count(*) from public.profiles where id='${pb.id}'`) === '0');
check('A 는 남아 있음', sql(`select count(*) from public.profiles where id='${pa.id}'`) === '1');
r = await call('/auth/v1/user', { token: tokB });
check('탈퇴한 B 의 토큰으로 사용자 조회 불가', r.status >= 400, r);
r = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: mail('b'), password: PW } });
check('탈퇴한 B 는 로그인 불가', r.status === 400, r);

// 10) 공개 가입 API(이메일 인증 필요) + 메타데이터
r = await call('/auth/v1/signup', { method: 'POST', body: { email: mail('c'), password: PW, data: { name: '이학부모', member_type: '학부모', grade: '중1', agree_terms: true, agree_privacy: true, agree_age: true, marketing: false } } });
check('공개 가입 → 인증 전이라 세션 없음', r.status === 200 && !r.json.access_token, r);
check('공개 가입도 트리거로 프로필 생성', sql(`select member_type||','||grade||','||(terms_agreed_at is not null)||','||marketing_opt_in from public.profiles p join auth.users u on u.id=p.id where u.email='${mail('c')}'`) === '학부모,중1,true,false');
r = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: mail('c'), password: PW } });
check('인증 전 로그인 거부(email_not_confirmed)', r.status === 400 && /confirm/i.test(JSON.stringify(r.json)), r);
r = await call('/auth/v1/signup', { method: 'POST', body: { email: mail('d'), password: 'short1' } });
check('8자 미만 비밀번호 거부', r.status === 422 || r.status === 400, r);
check('비밀번호는 bcrypt 해시로만 저장', /^\$2[aby]\$/.test(sql(`select encrypted_password from auth.users where email='${mail('a')}'`)));

// 11) 3개월 지난 로그인 기록·세션 자동 삭제
const uidA = pa.id;
sql(`insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address) values
  ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), '{"test":"old-${stamp}"}', now() - interval '91 days', '10.0.0.1'),
  ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), '{"test":"new-${stamp}"}', now() - interval '89 days', '10.0.0.2')`);
sql(`insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at) values
  (gen_random_uuid(), '${uidA}', now() - interval '200 days', now() - interval '120 days', null),
  (gen_random_uuid(), '${uidA}', now() - interval '200 days', now() - interval '120 days', (now() - interval '1 day')::timestamp)`);
sql('select private.purge_auth_logs()');
check('정리 작업: 91일 지난 로그인 기록 삭제', sql(`select count(*) from auth.audit_log_entries where payload->>'test' = 'old-${stamp}'`) === '0');
check('정리 작업: 89일 된 기록은 유지', sql(`select count(*) from auth.audit_log_entries where payload->>'test' = 'new-${stamp}'`) === '1');
check('정리 작업: 오래 안 쓴 세션 삭제, 최근 갱신된 세션 유지',
  sql(`select count(*) from auth.sessions where user_id = '${uidA}' and created_at < now() - interval '199 days'`) === '1');
check('정리 작업이 매일 예약되어 있음', sql(`select count(*) from cron.job where jobname = 'snucoach-purge-auth-logs' and command = 'select private.purge_auth_logs()'`) === '1');
sql(`delete from auth.audit_log_entries where payload->>'test' = 'new-${stamp}'`);

// 12) 목표 대학 입시 정보 알림
{
  const e = await adminCreate(mail('e'), fullMeta);
  const f = await adminCreate(mail('f'), fullMeta);
  const tokE = await login(mail('e')), tokF = await login(mail('f'));
  const rep = { prefer: 'return=representation' };
  r = await call('/rest/v1/target_alerts', { method: 'POST', token: tokE, body: [{ univ: '연세대', track: '자연' }, { univ: '고려대', track: '자연' }], headers: rep });
  check('알림 신청(인서울 주요 대학) 저장', r.status === 201 && r.json.length === 2 && r.json[0].user_id === e.json.id, r);
  r = await call('/rest/v1/target_alerts', { method: 'POST', token: tokE, body: { univ: '고려대(세종)' } });
  check('대상 외 대학(고려대 세종) 거부', r.status === 400, r);
  r = await call('/rest/v1/target_alerts', { method: 'POST', token: tokE, body: { univ: '부산대' } });
  check('대상 외 대학(지방) 거부', r.status === 400, r);
  r = await call('/rest/v1/target_alerts', { method: 'POST', token: tokE, body: { univ: '연세대' } });
  check('같은 대학 중복 신청 거부(409)', r.status === 409, r);
  r = await call('/rest/v1/target_alerts?on_conflict=user_id,univ', { method: 'POST', token: tokE, body: [{ univ: '연세대', track: '인문' }, { univ: '서울대', track: '자연' }], headers: { prefer: 'resolution=ignore-duplicates,return=representation' } });
  check('이미 신청한 대학은 건너뛰고 새 대학만 추가', (r.status === 200 || r.status === 201) && r.json.length === 1 && r.json[0].univ === '서울대', r);
  r = await call('/rest/v1/target_alerts?univ=eq.연세대', { method: 'PATCH', token: tokE, body: { track: '인문' } });
  check('신청 내용 수정은 막힘(해제 후 다시 신청)', r.status === 401 || r.status === 403, r);
  r = await call('/rest/v1/target_alerts', { method: 'POST', token: tokF, body: { univ: '서울대', user_id: e.json.id } });
  check('남의 이름으로 신청 불가', r.status === 401 || r.status === 403, r);
  r = await call('/rest/v1/target_alerts?select=univ', { token: tokF });
  check('남의 알림은 안 보임', r.status === 200 && r.json.length === 0, r);
  r = await call('/rest/v1/target_alerts?univ=eq.고려대', { method: 'DELETE', token: tokF, headers: rep });
  check('남의 알림 삭제 불가(0행)', r.status === 200 && r.json.length === 0, r);
  r = await call('/rest/v1/target_alerts?select=univ');
  check('비로그인 조회 불가', r.status === 401 || r.status === 403, r);
  r = await call('/rest/v1/rpc/admin_list_target_alerts', { method: 'POST', token: tokE, body: {} });
  check('일반 회원은 알림 목록(관리자) 거부', r.status === 401 || r.status === 403, r);
  r = await call('/rest/v1/rpc/admin_list_target_alerts', { method: 'POST', token: tokA, body: {} }); // A 는 위에서 관리자로 지정됨
  check('관리자는 알림 신청 목록 조회', r.status === 200 && r.json.some((x) => x.email === mail('e') && x.univ === '연세대' && x.track === '자연'), r);
  r = await call('/rest/v1/target_alerts?univ=eq.고려대', { method: 'DELETE', token: tokE, headers: rep });
  check('본인 알림 해제', r.status === 200 && r.json.length === 1, r);
  sql(`delete from auth.users where email='${mail('e')}'`);
  check('탈퇴하면 알림도 삭제', sql(`select count(*) from public.target_alerts where user_id='${e.json.id}'`) === '0');
}

// 정리
sql(`delete from auth.users where email like 'api-%-${stamp}@example.com'`);
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
