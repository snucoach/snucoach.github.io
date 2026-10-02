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
const fullMeta = { name: '  김학생  ', member_type: '학생', grade: '고2', agree_terms: true, agree_privacy: true, agree_age: true, marketing: true, phone: '010-1234-5678', marketing_sms: true };

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
check('휴대전화 번호는 숫자만 저장 + 수집 동의 시각', pa.phone === '01012345678' && !!pa.phone_agreed_at, pa);
check('문자 수신 동의와 시각 기록(이메일 동의와 따로)', pa.marketing_sms_opt_in === true && !!pa.marketing_sms_opt_in_at, pa);
check('가입 정보(auth.users)에는 번호·문자 동의 사본을 남기지 않음',
  sql(`select (raw_user_meta_data ? 'phone') or (raw_user_meta_data ? 'marketing_sms') from auth.users where id='${pa.id}'`) === 'f');
{
  const me = await call('/auth/v1/user', { token: tokA });
  check('로그인 정보(user_metadata)에 번호가 실리지 않음', me.status === 200 && !('phone' in (me.json.user_metadata || {})) && me.json.user_metadata.name === '  김학생  ', me.json.user_metadata);
}
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
check('번호 없는 가입 정보: phone 은 비고 문자 수신은 미동의', pb.phone === null && pb.phone_agreed_at === null && pb.marketing_sms_opt_in === false, pb);

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

// 6-1) 휴대전화 번호 · 문자 수신 동의
{
  const rep = { prefer: 'return=representation' };
  const patch = (id, tok, body) => call(`/rest/v1/profiles?id=eq.${id}`, { method: 'PATCH', token: tok, body, headers: rep });
  // 옛 가입 화면(문구가 '이메일'뿐)은 marketing 만 보낸다 → 문자 동의로 기록하면 안 된다
  const o = await adminCreate(mail('old'), { name: '옛화면', member_type: '학생', grade: '고1', agree_terms: true, agree_privacy: true, agree_age: true, marketing: true });
  const tokO = await login(mail('old'));
  r = await call('/rest/v1/profiles?select=*', { token: tokO });
  const po = r.json[0] || {};
  check('옛 가입 정보(marketing 만): 이메일만 동의, 문자 미동의·번호 없음', po.marketing_opt_in === true && po.marketing_sms_opt_in === false && po.phone === null, po);
  r = await patch(po.id, tokO, { marketing_sms_opt_in: true });
  check('번호 없이 문자 수신을 켜면 기록되지 않음(false 유지)', r.status === 200 && r.json[0].marketing_sms_opt_in === false && r.json[0].marketing_sms_opt_in_at === null, r);
  for (const bad of ['02-123-4567', '0101234567', '010-1234-56789', '012-345-6789', '', 'abc']) {
    r = await patch(po.id, tokO, { phone: bad });
    check(`형식이 틀린 번호 ${JSON.stringify(bad)} 거부(400, profiles_phone_format)`, r.status === 400 && /profiles_phone_format/.test(JSON.stringify(r.json)), r);
  }
  r = await patch(po.id, tokO, { phone: '+82 10-9999-8888' });
  check('번호 저장: 숫자만(+82 는 0 으로), 수집 동의 시각은 서버 시각', r.status === 200 && r.json[0].phone === '01099998888' && fresh(r.json[0].phone_agreed_at) && r.json[0].marketing_sms_opt_in === false, r);
  r = await patch(po.id, tokO, { phone_agreed_at: '2001-01-01T00:00:00Z' });
  check('phone_agreed_at 직접 쓰기 차단', r.status === 401 || r.status === 403, r);
  r = await patch(po.id, tokO, { marketing_sms_opt_in: true, marketing_sms_opt_in_at: '2001-01-01T00:00:00Z' });
  check('marketing_sms_opt_in_at 직접 쓰기 차단', r.status === 401 || r.status === 403, r);
  r = await patch(po.id, tokO, { marketing_sms_opt_in: true });
  check('문자 수신 동의 → 서버 시각 기록, 이메일 동의는 그대로', r.status === 200 && r.json[0].marketing_sms_opt_in === true && fresh(r.json[0].marketing_sms_opt_in_at) && r.json[0].marketing_opt_in === true, r);
  r = await patch(po.id, tokO, { marketing_opt_in: false });
  check('이메일만 철회 → 문자 동의 유지', r.status === 200 && r.json[0].marketing_opt_in === false && r.json[0].marketing_sms_opt_in === true, r);
  r = await patch(po.id, tokA, { phone: '01000000000' });
  check('남의 번호는 못 고친다(0행)', r.status === 200 && Array.isArray(r.json) && r.json.length === 0, r);
  r = await patch(po.id, tokO, { phone: null });
  check('번호를 지우면 문자 동의도 꺼지고 수집 동의 시각이 지워짐', r.status === 200 && r.json[0].phone === null && r.json[0].phone_agreed_at === null && r.json[0].marketing_sms_opt_in === false, r);
  // 알림 신청은 번호가 있는 회원만(20261002010000_phone_alert_enforce.sql)
  r = await call('/rest/v1/target_alerts', { method: 'POST', token: tokO, body: { univ: '서울대' } });
  check('번호 없는 회원의 알림 신청 거부(400, 23514)', r.status === 400 && r.json.code === '23514' && /휴대전화/.test(r.json.message || ''), r);
  r = await patch(po.id, tokO, { phone: '010-9999-8888' });
  r = await call('/rest/v1/target_alerts', { method: 'POST', token: tokO, body: { univ: '서울대' }, headers: rep });
  check('번호를 넣으면 알림 신청 가능', r.status === 201, r);
  // 가입 정보의 phone 형식이 틀리면 번호만 버리고 가입은 진행
  const w = await adminCreate(mail('wrong'), { ...fullMeta, phone: '02-123-4567' });
  check('가입 정보의 번호 형식이 틀려도 가입은 진행', w.status === 200, w);
  check('  → 번호는 비우고 문자 동의도 기록하지 않음', sql(`select (phone is null)::text||','||marketing_sms_opt_in::text||','||marketing_opt_in::text from public.profiles where id='${w.json.id}'`) === 'true,false,true');
  sql(`delete from auth.users where email in ('${mail('old')}','${mail('wrong')}')`);
}

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
const rowA = rows.find((x) => x.id === pa.id) || {};
check('목록에 휴대전화 번호·문자 수신 동의 포함', rowA.phone === '01012345678' && rowA.marketing_sms_opt_in === true && !!rowA.marketing_sms_opt_in_at && rowB.phone === null && rowB.marketing_sms_opt_in === false, [rowA, rowB]);
check('번호가 없어도 가입 마무리 여부는 그대로(완료)', rowB.profile_completed === true && rowB.phone === null, rowB);
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
  check('알림 신청 목록에 휴대전화 번호 포함', r.status === 200 && r.json.some((x) => x.email === mail('e') && x.phone === '01012345678'), r);
  check('번호를 받은 뒤 신청한 알림은 문자로 보낼 수 있음(sms_ok)', r.status === 200 && r.json.filter((x) => x.email === mail('e')).every((x) => x.sms_ok === true), r);
  sql(`update public.target_alerts set created_at = now() - interval '30 days' where user_id='${e.json.id}' and univ='연세대'`);
  r = await call('/rest/v1/rpc/admin_list_target_alerts', { method: 'POST', token: tokA, body: {} });
  check('번호를 받기 전에 신청한 알림은 이메일만(sms_ok=false)', r.status === 200 && r.json.some((x) => x.email === mail('e') && x.univ === '연세대' && x.sms_ok === false), r);
  r = await call('/rest/v1/target_alerts?univ=eq.고려대', { method: 'DELETE', token: tokE, headers: rep });
  check('본인 알림 해제', r.status === 200 && r.json.length === 1, r);
  sql(`delete from auth.users where email='${mail('e')}'`);
  check('탈퇴하면 알림도 삭제', sql(`select count(*) from public.target_alerts where user_id='${e.json.id}'`) === '0');
}

// 13) 회원 후기 (20261003000000_reviews.sql)
// PGlite 로는 확인하지 못한 것을 여기서 본다: 직접 정한 오류 코드(RV…)가 그대로 오는지, 열 권한이 걸린 표에 REST 로 쓰기·고치기·지우기가 되는지.
{
  const g = await adminCreate(mail('g'), { ...fullMeta, name: '김후기' });
  const h = await adminCreate(mail('h'), { ...fullMeta, name: '이후기' });
  const tokG = await login(mail('g')), tokH = await login(mail('h'));
  const rep = { prefer: 'return=representation' };
  const post = (tok, body, q = '?select=id') => call('/rest/v1/reviews' + q, { method: 'POST', token: tok, body, headers: rep });
  r = await call('/rest/v1/reviews_public?select=id,rating,program,body,author,verified,created_at,updated_at&order=id.desc&limit=11', { headers: { prefer: 'count=exact' } });
  check('후기: 비로그인 공개 조회(뷰, 건수 포함)', r.status === 200 || r.status === 206, r);
  r = await post(tokG, { rating: 4, program: '학습코칭', body: '  계획 세우는 습관이 잡혔습니다.\n\n\n아쉬운 점은 없었어요  ' });
  check('후기: 작성(넣는 칸 3개 + select=id)', r.status === 201 && !!r.json[0] && r.json[0].id > 0, r);
  const rid = r.json[0] && r.json[0].id;
  r = await call(`/rest/v1/reviews_public?select=*&id=eq.${rid}`);
  check('후기: 공개 조회는 칸 8개, 가린 이름, 정리된 본문', r.status === 200 && r.json.length === 1
    && Object.keys(r.json[0]).sort().join() === 'author,body,created_at,id,program,rating,updated_at,verified'
    && r.json[0].author === '김**' && r.json[0].body === '계획 세우는 습관이 잡혔습니다.\n\n아쉬운 점은 없었어요', r);
  r = await call('/rest/v1/reviews?select=*');
  check('후기: 표 select=* 거부', r.status === 401 || r.status === 403, r);
  r = await call('/rest/v1/reviews?select=user_id');
  check('후기: user_id 조회 거부', r.status === 401 || r.status === 403, r);
  r = await call('/rest/v1/reviews?select=user_id', { token: tokH });
  check('후기: 로그인한 회원도 user_id 조회 거부', r.status === 401 || r.status === 403, r);
  r = await post(tokG, { rating: 4, program: '기타', body: '전체 칸을 돌려 달라고 하면 거절됩니다.' }, '');
  check('후기: 전체 칸을 돌려 달라는 작성 요청은 거부(열 권한)', r.status === 401 || r.status === 403, r);
  r = await post(tokG, { rating: 5, program: '기타', body: '수강 확인을 직접 넣어 봅니다.', verified: true });
  check('후기: verified 직접 넣기 거부', r.status === 401 || r.status === 403, r);
  r = await post(tokG, { rating: 5, program: '기타', body: '남의 이름으로 써 봅니다. 열 글자.', user_id: h.json.id });
  check('후기: user_id 지정 거부', r.status === 401 || r.status === 403, r);
  r = await post(tokG, { rating: 5, program: '학습코칭', body: '같은 프로그램에 두 번째 글을 씁니다.' });
  check('후기: 같은 프로그램 두 번째 글 거부(23505)', r.status === 409 && r.json.code === '23505', r);
  r = await post(tokG, { rating: 5, program: '기타', body: '짧음' });
  check('후기: 짧은 본문 거부(23514 + 제약 이름)', r.status === 400 && r.json.code === '23514' && /reviews_body_length/.test(r.json.message || ''), r);
  r = await post(tokA, { rating: 5, program: '기타', body: '관리자 계정으로 써 봅니다. 열 글자.' });
  check('후기: 관리자 계정 작성 거부(코드 RV003 이 그대로 오는지)', r.json.code === 'RV003', r);
  await post(tokG, { rating: 3, program: '생기부 컨설팅', body: '두 번째 프로그램 후기입니다. 열 글자.' });
  await post(tokG, { rating: 3, program: '무료 자료·이벤트', body: '세 번째 프로그램 후기입니다. 열 글자.' });
  r = await post(tokG, { rating: 3, program: '기타', body: '네 번째 후기는 하루 한도를 넘습니다.' });
  check('후기: 하루 4번째 글 거부(코드 RV001 이 그대로 오는지)', r.json.code === 'RV001', r);
  r = await call(`/rest/v1/reviews?id=eq.${rid}&select=id`, { method: 'PATCH', token: tokH, body: { rating: 1 }, headers: rep });
  check('후기: 남의 글 수정 0행', r.status === 200 && r.json.length === 0, r);
  r = await call(`/rest/v1/reviews?id=eq.${rid}&select=id`, { method: 'PATCH', token: tokG, body: { rating: 5, program: '학습코칭', body: '고쳐 쓴 후기입니다. 여전히 만족합니다.' }, headers: rep });
  check('후기: 본인 글 수정(칸 3개 + select=id)', r.status === 200 && r.json.length === 1, r);
  r = await call(`/rest/v1/reviews?id=eq.${rid}`, { method: 'PATCH', token: tokG, body: { verified: true } });
  check('후기: 본인 글의 verified 수정 거부', r.status === 401 || r.status === 403, r);
  r = await call('/rest/v1/rpc/my_review_status', { method: 'POST', token: tokG, body: {} });
  check('후기: my_review_status(ok + 가린 이름)', r.status === 200 && r.json[0].state === 'ok' && r.json[0].author === '김**', r);
  r = await call('/rest/v1/rpc/my_review_status', { method: 'POST', body: {} });
  check('후기: 비로그인 my_review_status 거부', r.status === 401 || r.status === 403, r);
  r = await call('/rest/v1/rpc/admin_set_review_hidden', { method: 'POST', token: tokG, body: { p_id: rid, p_hidden: true, p_reason: '법령 위반', p_note: '마음에 안 듦' } });
  check('후기: 일반 회원의 숨김 거부', r.status === 401 || r.status === 403, r);
  r = await call('/rest/v1/rpc/admin_set_review_hidden', { method: 'POST', token: tokA, body: { p_id: rid, p_hidden: true, p_reason: '평점 낮음' } });
  check('후기: 목록에 없는 숨김 사유 거부(23514)', r.json.code === '23514', r);
  r = await call('/rest/v1/rpc/admin_set_review_hidden', { method: 'POST', token: tokA, body: { p_id: rid, p_hidden: true, p_reason: '개인정보 노출', p_note: '시험' } });
  check('후기: 관리자 숨김', r.status === 204 || r.status === 200, r);
  r = await call(`/rest/v1/reviews_public?select=id&id=eq.${rid}`);
  check('후기: 숨긴 글은 공개 조회에 없음', r.status === 200 && r.json.length === 0, r);
  r = await call('/rest/v1/rpc/review_hidden_stats');
  check('후기: 숨김 현황은 비로그인 GET 으로 조회(사유별 건수)', r.status === 200 && r.json.some((x) => x.reason === '개인정보 노출' && x.n >= 1), r);
  r = await call('/rest/v1/rpc/my_reviews', { method: 'POST', token: tokG, body: {} });
  check('후기: 작성자는 my_reviews 로 숨김 사유와 구체 사유(메모) 확인', r.status === 200 && r.json.some((x) => x.id === rid && x.hidden === true && x.hidden_reason === '개인정보 노출' && x.hidden_detail === '시험' && !('user_id' in x)), r);
  r = await call('/rest/v1/rpc/admin_log_review_notice', { method: 'POST', token: tokA, body: { p_id: rid, p_kind: '숨김 안내' } });
  check('후기: 작성자 알림 기록', r.status === 204 || r.status === 200, r);
  r = await call('/rest/v1/rpc/admin_log_review_notice', { method: 'POST', token: tokG, body: { p_id: rid, p_kind: '숨김 안내' } });
  check('후기: 일반 회원의 알림 기록 거부', r.status === 403 || r.json.code === '42501', r);
  r = await call('/rest/v1/rpc/admin_list_reviews', { method: 'POST', token: tokA, body: {} });
  check('후기: 관리자 목록(이름·이메일 있음, 휴대전화·user_id 없음)', r.status === 200 && r.json.some((x) => x.id === rid && x.email === mail('g') && !('phone' in x) && !('user_id' in x)), r);
  r = await call('/rest/v1/rpc/admin_set_review_hidden', { method: 'POST', token: tokA, body: { p_id: 99999999, p_hidden: true, p_reason: '광고·스팸' } });
  check('후기: 없는 글(코드 RV004 가 그대로 오는지)', r.json.code === 'RV004', r);
  r = await call(`/rest/v1/reviews?id=eq.${rid}&select=id`, { method: 'DELETE', token: tokH, headers: rep });
  check('후기: 남의 글 삭제 0행', r.status === 200 && r.json.length === 0, r);
  r = await call(`/rest/v1/reviews?id=eq.${rid}&select=id`, { method: 'DELETE', token: tokG, headers: rep });
  check('후기: 본인 글 삭제(숨긴 글)', r.status === 200 && r.json.length === 1, r);
  check('후기: 글을 지워도 처리 기록은 남음(숨김 + 알림)', sql(`select count(*) from private.review_moderation_log where review_id = ${rid}`) === '2');
  sql(`update private.review_quota set n = 0 where user_id='${g.json.id}'`);
  r = await post(tokG, { rating: 5, program: '생기부 컨설팅', body: '숨김 처리된 글을 지운 뒤에 새 글을 올려 봅니다.' });
  check('후기: 숨김 처리된 글을 지운 뒤 새 글 거부(코드 RV007 이 그대로 오는지)', r.json.code === 'RV007', r);
  r = await call('/rest/v1/rpc/my_review_status', { method: 'POST', token: tokG, body: {} });
  check('후기: my_review_status(hold + 끝나는 시각)', r.status === 200 && r.json[0].state === 'hold' && !!r.json[0].hold_until, r);
  sql(`delete from auth.users where email='${mail('g')}'`);
  check('후기: 탈퇴하면 후기·횟수 기록 삭제', sql(`select count(*) from public.reviews where user_id='${g.json.id}'`) === '0' && sql(`select count(*) from private.review_quota where user_id='${g.json.id}'`) === '0');
  check('후기: 정리 작업이 매일 예약되어 있음', sql(`select count(*) from cron.job where jobname = 'snucoach-purge-review-records'`) === '1');
}

// 정리
sql(`delete from auth.users where email like 'api-%-${stamp}@example.com'`);
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
