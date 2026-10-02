// 회원 후기 마이그레이션 검증 (Docker 없이, PGlite = 브라우저용으로 빌드한 PostgreSQL)
//
//   cd supabase/local && npm i --no-save @electric-sql/pglite && node reviews-db.mjs
//   (이미 설치한 곳이 있으면)  PGLITE_FROM=/설치한/폴더 node supabase/local/reviews-db.mjs
//
// 저장소의 마이그레이션 파일을 그대로 읽어 적용하고, 권한·RLS·트리거·관리자 함수·공격 시나리오를 확인한다.
// 실제 Supabase 와 다른 점: 인증 서버·PostgREST 가 없다(역할 anon/authenticated 와 auth.uid() 만 흉내 낸다).
// 운영 DB 로는 아무것도 보내지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const require = createRequire(process.env.PGLITE_FROM ? path.resolve(process.env.PGLITE_FROM) + path.sep : import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (e) {
  console.error('PGlite 를 찾지 못했습니다. `cd supabase/local && npm i --no-save @electric-sql/pglite` 뒤 다시 실행하거나 PGLITE_FROM 으로 설치한 폴더를 알려 주세요.');
  process.exit(2);
}
const MIG = (f) => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8')
  .replace(/create extension if not exists pg_cron;/, '-- (pglite) pg_cron 은 아래 흉내로 대신한다');
const R_FILE = '20261003000000_reviews.sql';
const R = MIG(R_FILE), RB = fs.readFileSync(path.join(ROOT, 'supabase', 'reviews-rollback.sql'), 'utf8');
const M1 = MIG('20261001000000_members.sql'), M2 = MIG('20261001010000_target_alerts.sql');
const P = MIG('20261002000000_phone.sql'), E = MIG('20261002010000_phone_alert_enforce.sql');

async function boot() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema cron;
    grant usage on schema auth to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text unique,
      raw_app_meta_data jsonb default '{"provider":"email"}', raw_user_meta_data jsonb default '{}',
      email_confirmed_at timestamptz, created_at timestamptz default now(), last_sign_in_at timestamptz);
    create table auth.audit_log_entries (id uuid, created_at timestamptz);
    create table auth.sessions (id uuid, user_id uuid, created_at timestamptz, updated_at timestamptz, refreshed_at timestamp);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant execute on function auth.uid() to anon, authenticated;
    create table cron.job (jobname text primary key, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns bigint language sql as $$
      insert into cron.job values (n, s, c) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning 1::bigint $$;
    create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
    -- Supabase 기본값 흉내: public 스키마의 새 객체는 anon·authenticated 에게 열려 있다(그래서 마이그레이션이 revoke 를 한다)
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  // 결과: 행 배열, 또는 { ERR: 코드, message, detail }
  const q = async (sql, params) => { try { return (await db.query(sql, params)).rows; } catch (e) { return { ERR: e.code || '?', message: e.message, detail: e.detail, hint: e.hint }; } };
  const x = async (sql) => { try { await db.exec(sql); return 'ok'; } catch (e) { try { await db.exec('rollback'); } catch (e2) { /* 트랜잭션 밖 */ } return `ERR[${e.code || ''}] ${e.message}`; } };
  const as = async (uid, sql) => { await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false);`); const r = await q(sql); await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);`); return r; };
  const anon = async (sql) => { await db.exec(`set role anon;`); const r = await q(sql); await db.exec(`reset role;`); return r; };
  return { db, q, x, as, anon };
}

let fail = 0, total = 0;
const ok = (name, cond, got) => { total++; if (!cond) fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  → ' + JSON.stringify(got, (k, v) => (typeof v === 'bigint' ? Number(v) : v)))); };
const id = (n) => `00000000-0000-0000-0000-0000000000${n}`;
const full = (name) => `{"name":${JSON.stringify(name)},"member_type":"학생","grade":"고2","agree_terms":true,"agree_privacy":true,"agree_age":true}`;
const T = (d) => (d instanceof Date ? d.toISOString() : String(d));
const err = (r, code, text) => !!r && !Array.isArray(r) && r.ERR === code && (!text || String(r.message).includes(text));
const rows = (r, n) => Array.isArray(r) && (n === undefined || r.length === n);
const B = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const INS = (rating, program, body) => `insert into public.reviews (rating, program, body) values (${rating}, ${B(program)}, ${B(body)}) returning id, author_label, verified, hidden_at, created_at, updated_at`;
const GOOD = '코칭 받고 계획 세우는 습관이 잡혔습니다.';

// ───────────── 0. 파일 자체 ─────────────
{
  const raw = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', R_FILE), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'reviews.js'), 'utf8');
  // 보이지 않는 글자가 원문 그대로 들어 있으면 안 된다(옮겨 적다가 빠져도 오류 없이 규칙만 달라진다)
  const INVIS = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]/;
  ok('0-1 마이그레이션 파일에 보이지 않는 글자(U+200B~U+FEFF 등) 원문 0건', !INVIS.test(raw), [...raw].filter((c) => INVIS.test(c)).map((c) => c.codePointAt(0).toString(16)));
  ok('0-2 reviews.js 에 보이지 않는 글자 원문 0건', !INVIS.test(js), [...js].filter((c) => INVIS.test(c)).map((c) => c.codePointAt(0).toString(16)));
  ok('0-3 비밀값 없음', !/sb_secret_|service_role/i.test(raw + js));
}

// ───────────── A. 순서 ─────────────
{
  const { x, q } = await boot();
  const r = await x(R);
  ok('A1 members.sql 없이 실행 → 거절', r.includes('20261001000000_members.sql 을 먼저'), r);
  ok('A2 거절 뒤 표가 남지 않음', (await q(`select to_regclass('public.reviews') t`))[0].t === null);
}
for (const [label, seq] of [
  ['M1→R (알림 표 없이)', [M1, R]],
  ['M1→M2→R (운영 DB 현재 상태)', [M1, M2, R]],
  ['M1→M2→P→R', [M1, M2, P, R]],
  ['M1→M2→P→E→R', [M1, M2, P, E, R]],
  ['M1→M2→R→P→E→R→P', [M1, M2, R, P, E, R, P]],
]) {
  const { x } = await boot();
  const rs = [];
  for (const s of seq) rs.push(await x(s));
  ok(`A3 순서 ${label}`, rs.every((v) => v === 'ok'), rs);
}

// ───────────── 본 검증: 운영 DB 상태(M1+M2)에서 시작 ─────────────
const { db, q, x, as, anon } = await boot();
ok('B0 M1·M2', (await x(M1)) === 'ok' && (await x(M2)) === 'ok');
const KIM = id('01'), LEE = id('02'), HALF = id('03'), NICK = id('04'), EN = id('05'), ADM = id('09'), SPAM = id('11'), BAN = id('12'), EDIT = id('13');
await db.exec(`insert into auth.users (id,email,raw_user_meta_data) values
 ('${KIM}','kim@x.com','${full('김철수')}'), ('${LEE}','lee@x.com','${full('이영')}'), ('${ADM}','adm@x.com','${full('유정원')}'),
 ('${HALF}','half@x.com','{"name":"미완"}'), ('${NICK}','nick@x.com','${full('★행복한고양이')}'), ('${EN}','en@x.com','${full('john smith')}'),
 ('${SPAM}','spam@x.com','${full('박도배')}'), ('${BAN}','ban@x.com','${full('최제한')}'), ('${EDIT}','edit@x.com','${full('정수정')}')`);
await db.exec(`update public.profiles set is_admin=true where id='${ADM}'`);
const profBefore = JSON.stringify(await q(`select * from public.profiles order by id`));
const objs = async () => JSON.stringify([
  await q(`select n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') order by 1,2`),
  await q(`select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') order by 1,2,3`),
  await q(`select jobname from cron.job order by 1`)]);
const objsBefore = await objs();

let r = [await x(R), await x(R), await x(R)];
ok('B1 reviews.sql 3회 실행', r.every((v) => v === 'ok'), r);
ok('B2 프로필 표는 그대로', JSON.stringify(await q(`select * from public.profiles order by id`)) === profBefore);

// ── 구조·권한 ──
r = await q(`select polname from pg_policy where polrelid='public.reviews'::regclass order by 1`);
ok('C1 정책 5개(중복 없음)', r.length === 5, r);
r = (await q(`select tgname from pg_trigger where tgrelid='public.reviews'::regclass and not tgisinternal order by 1`)).map((v) => v.tgname).join();
ok('C2 트리거 3개', r === 'reviews_after_insert,reviews_before_insert,reviews_before_update', r);
r = (await q(`select conname from pg_constraint where conrelid='public.reviews'::regclass and contype='c' order by 1`)).map((v) => v.conname);
ok('C3 CHECK 7개', r.length === 7 && r.includes('reviews_verified_program'), r);
r = await q(`select c.relname, c.reloptions, c.relrowsecurity from pg_class c where c.oid in ('public.reviews'::regclass,'public.reviews_public'::regclass,'private.review_quota'::regclass,'private.review_ban'::regclass,'private.review_moderation_log'::regclass) order by 1`);
ok('C4 뷰 security_invoker, 표 4개 RLS 켜짐', JSON.stringify(r.find((v) => v.relname === 'reviews_public').reloptions).includes('security_invoker=true') && r.filter((v) => v.relname !== 'reviews_public').every((v) => v.relrowsecurity === true), r);
r = (await q(`select column_name from information_schema.column_privileges where table_schema='public' and table_name='reviews' and grantee='anon' and privilege_type='SELECT' order by 1`)).map((v) => v.column_name).join();
ok('C5 anon 이 읽을 수 있는 칸 9개', r === 'author_label,body,created_at,hidden_at,id,program,rating,updated_at,verified', r);
r = (await q(`select privilege_type||':'||column_name c from information_schema.column_privileges where table_schema='public' and table_name='reviews' and grantee='authenticated' and privilege_type in ('INSERT','UPDATE') order by 1`)).map((v) => v.c).join();
ok('C6 회원이 쓰고 고칠 수 있는 칸 3개', r === 'INSERT:body,INSERT:program,INSERT:rating,UPDATE:body,UPDATE:program,UPDATE:rating', r);
r = (await q(`select grantee||':'||privilege_type c from information_schema.table_privileges where table_schema='public' and table_name='reviews' and grantee in ('anon','authenticated') order by 1`)).map((v) => v.c).join();
ok('C7 표 단위 권한: 회원의 DELETE 뿐', r === 'authenticated:DELETE', r);
r = (await q(`select grantee||':'||privilege_type c from information_schema.table_privileges where table_schema='public' and table_name='reviews_public' and grantee in ('anon','authenticated') order by 1`)).map((v) => v.c).join();
ok('C8 뷰 권한은 select 만', r === 'anon:SELECT,authenticated:SELECT', r);
r = await q(`select p.proname, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('my_reviews','my_review_status','admin_list_reviews','admin_set_review_hidden','admin_set_review_verified','admin_list_review_log') order by 1`);
ok('C9 회원용·관리자용 함수 6개: anon 불가·회원 호출 가능', r.length === 6 && r.every((v) => !v.anon && v.auth), r);
r = await q(`select has_function_privilege('anon', 'public.review_hidden_stats()', 'execute') anon, has_function_privilege('authenticated', 'public.review_hidden_stats()', 'execute') auth`);
ok('C10 숨김 현황 함수: anon·회원 호출 가능', r[0].anon && r[0].auth, r);
r = await q(`select p.proname, p.prosecdef, p.proconfig, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('anon', p.oid, 'execute') anon
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and (proname like 'review%' or proname = 'purge_review_records') order by 1`);
ok('C11 private 함수 6개: 회원·anon 직접 실행 불가, search_path 고정', r.length === 6 && r.every((v) => !v.auth && !v.anon && JSON.stringify(v.proconfig).includes('search_path=')), r);
r = await q(`select has_schema_privilege('anon','private','usage') a, has_schema_privilege('authenticated','private','usage') b, has_sequence_privilege('anon','public.reviews_id_seq','usage') c, has_sequence_privilege('authenticated','public.reviews_id_seq','usage') d`);
ok('C12 private 스키마·번호 시퀀스 권한 없음', !r[0].a && !r[0].b && !r[0].c && !r[0].d, r);
r = await q(`select jobname, schedule, command from cron.job where jobname like 'snucoach-purge-review%'`);
ok('C13 정리 작업 1개', r.length === 1 && r[0].jobname === 'snucoach-purge-review-records' && r[0].schedule === '37 3 * * *', r);
r = await q(`select column_name from information_schema.columns where table_schema='private' and table_name='review_moderation_log' order by 1`);
ok('C14 처리 기록 표에 user_id·본문 칸이 없음', !r.some((v) => /user_id|body|author|email|name/.test(v.column_name)), r.map((v) => v.column_name));

// ── 작성 ──
r = await anon(INS(5, '학습코칭', GOOD));
ok('D1 비로그인 작성 거절(42501)', err(r, '42501'), r);
r = await as(HALF, INS(5, '학습코칭', GOOD));
ok('D2 가입 마무리 전 회원 거절(RV002)', err(r, 'RV002', '가입 마무리'), r);
r = await as(ADM, INS(5, '학습코칭', GOOD));
ok('D2b 관리자 계정은 후기를 쓸 수 없음(RV003)', err(r, 'RV003', '관리자 계정'), r);
r = await as(KIM, INS(5, '학습코칭', GOOD));
ok('D3 작성 → 바로 게시, 가린 이름 김**', rows(r, 1) && r[0].author_label === '김**' && r[0].verified === false && r[0].hidden_at === null && T(r[0].created_at) === T(r[0].updated_at), r);
const K1 = r[0] && r[0].id;
for (const [name, cols, vals] of [
  ['verified', 'verified', 'true'], ['user_id', 'user_id', `'${LEE}'`], ['author_label', 'author_label', `'유정원'`], ['hidden_at', 'hidden_at', 'now()'],
  ['created_at', 'created_at', `now() - interval '1 year'`], ['verified+verified_at', 'verified, verified_at', 'true, now()'],
]) {
  r = await as(KIM, `insert into public.reviews (rating, program, body, ${cols}) values (5,'기타',${B(GOOD)}, ${vals})`);
  ok(`D4 ${name} 직접 넣기 거절(42501)`, err(r, '42501'), r);
}
for (const [name, sql, code] of [
  ['별점 0', INS(0, '기타', GOOD), '23514'], ['별점 6', INS(6, '기타', GOOD), '23514'],
  ['프로그램 값 틀림', INS(5, '수학 과외', GOOD), '23514'],
  ['본문 9자', INS(5, '기타', '아홉글자입니다요일이'.slice(0, 9)), '23514'],
  ['본문 공백뿐', INS(5, '기타', '              '), '23514'],
  ['본문 1,001자', INS(5, '기타', '가'.repeat(1001)), '23514'],
  ['폭 없는 공백으로 길이 채우기', INS(5, '기타', 'ㅋ' + '\u200B'.repeat(20)), '23514'],
  ['한글 채움 문자(U+3164)만', INS(5, '기타', '\u3164'.repeat(12)), '23514'],
  ['점자 빈칸(U+2800)만', INS(5, '기타', '\u2800'.repeat(12)), '23514'],
  ['전각 공백(U+3000)만', INS(5, '기타', '\u3000'.repeat(12)), '23514'],
  ['줄바꿈 금지 공백(U+00A0)만', INS(5, '기타', '\u00A0'.repeat(12)), '23514'],
  ['태그 문자(U+E0020)로 채우기', INS(5, '기타', 'a' + '\u{E0020}'.repeat(12)), '23514'],
  ['결합 기호 999개(글자 번짐)', INS(5, '기타', 'a' + '\u0301'.repeat(999)), '23514'],
]) { r = await as(KIM, sql); ok(`D5 ${name} 거절(${code})`, err(r, code), r); }
r = await as(KIM, INS(9, '기타', GOOD));
ok('D6 거절 오류에 다른 칸의 값이 딸려 나오지 않음(detail 없음)', err(r, '23514') && !/Failing row|user_id/.test(JSON.stringify(r)), r);
r = await q(`select n from private.review_quota where user_id='${KIM}'`);
ok('D7 거절된 시도는 횟수에 안 들어감(n=1)', r[0] && r[0].n === 1, r);
r = await as(KIM, INS(4, '학습코칭', '같은 프로그램에 한 번 더 써 봅니다.'));
ok('D8 같은 프로그램 두 번째 글 거절(23505), 오류에 user_id 없음', err(r, '23505', 'reviews_user_program_key') && !/Key \(user_id/.test(JSON.stringify(r)), r);
r = await as(KIM, `insert into public.reviews (rating, program, body) values (1, '학습코칭', '같은 프로그램에 또 씁니다. 열 글자 이상.') on conflict do nothing returning id`);
ok('D9 중복을 조용히 넘기는 요청 → 0건', rows(r, 0), r);
r = await as(KIM, `insert into public.reviews (rating, program, body) values (1, '학습코칭', '업서트로 바꿔 봅니다. 열 글자 이상입니다.') on conflict (user_id, program) do update set body = excluded.body returning id`);
ok('D9b 업서트(on conflict do update) 거절(42501)', err(r, '42501'), r);
r = await q(`select n from private.review_quota where user_id='${KIM}'`);
ok('D10 건너뛴 요청은 횟수에 안 들어감(n=1)', r[0] && r[0].n === 1, r);
r = await as(KIM, INS(3, '기타', '  첫째 줄입니다\r\n\r\n\r\n\r\n둘째\t줄입니다\u202E  \n '));
const K2 = r[0] && r[0].id;
r = await q(`select body from public.reviews where id=${K2}`);
ok('D11 본문 정리 저장(줄바꿈 통일·빈 줄 하나·탭→공백·방향 제어 문자 제거)', r[0] && r[0].body === '첫째 줄입니다\n\n둘째 줄입니다', r);
r = await as(KIM, INS(5, '생기부 컨설팅', '가'.repeat(1000)));
ok('D12 본문 1,000자 통과', rows(r, 1), r);
const K3 = r[0] && r[0].id;
r = await as(KIM, INS(5, '무료 자료·이벤트', GOOD));
ok('D13 하루 4번째 글 거절(RV001)', err(r, 'RV001', '하루에 3건'), r);
r = await q(`select n from private.review_quota where user_id='${KIM}'`);
ok('D13b 거절 뒤 횟수는 3 그대로', r[0].n === 3, r);
r = await as(KIM, `delete from public.reviews where id=${K3} returning id`);
ok('D14 본인 글 삭제', rows(r, 1) && r[0].id === K3, r);
r = await as(KIM, INS(5, '무료 자료·이벤트', GOOD));
ok('D15 지우고 다시 써도 그날은 거절(RV001)', err(r, 'RV001'), r);
await db.exec(`set timezone = 'Pacific/Kiritimati'`);
r = await as(KIM, INS(5, '무료 자료·이벤트', GOOD));
await db.exec(`reset timezone`);
ok('D16 세션 시간대를 바꿔도 한도 유지(RV001)', err(r, 'RV001'), r);
await db.exec(`update private.review_quota set day = day - 1 where user_id='${KIM}'`);
r = await as(KIM, INS(5, '무료 자료·이벤트', GOOD));
ok('D17 다음 날은 다시 쓸 수 있음', rows(r, 1), r);
const K4 = r[0] && r[0].id;
r = await q(`select n, edits, day = (now() at time zone 'Asia/Seoul')::date today from private.review_quota where user_id='${KIM}'`);
ok('D18 날짜가 바뀌면 횟수 1부터', r[0].n === 1 && r[0].edits === 0 && r[0].today === true, r);
r = await as(LEE, INS(1, '학습코칭', '기대한 것과 달라서 아쉬웠습니다. 피드백이 늦었어요.'));
ok('D19 이영 → 이** (별점 1도 바로 게시)', rows(r, 1) && r[0].author_label === '이**' && r[0].hidden_at === null, r);
const L1 = r[0].id;
r = await as(NICK, INS(5, '무료 자료·이벤트', GOOD));
ok('D20 ★행복한고양이 → 행**', rows(r, 1) && r[0].author_label === '행**', r);
r = await as(EN, INS(5, '기타', GOOD));
ok('D21 john smith → J**', rows(r, 1) && r[0].author_label === 'J**', r);
// 한 요청에 여러 줄
r = await as(SPAM, `insert into public.reviews (rating, program, body) values (5,'학습코칭','여러 줄을 한 번에 넣어 봅니다 1'),(5,'생기부 컨설팅','여러 줄을 한 번에 넣어 봅니다 2'),(5,'무료 자료·이벤트','여러 줄을 한 번에 넣어 봅니다 3'),(5,'기타','여러 줄을 한 번에 넣어 봅니다 4')`);
ok('D22 한 요청에 4줄 → 전체 거절(RV001), 한 줄도 안 들어감', err(r, 'RV001') && (await q(`select count(*)::int c from public.reviews where user_id='${SPAM}'`))[0].c === 0, r);
r = await as(SPAM, `insert into public.reviews (rating, program, body) values (5,'학습코칭','여러 줄을 한 번에 넣어 봅니다 1'),(5,'생기부 컨설팅','여러 줄을 한 번에 넣어 봅니다 2'),(5,'무료 자료·이벤트','여러 줄을 한 번에 넣어 봅니다 3') returning id`);
ok('D23 한 요청에 3줄 → 통과', rows(r, 3), r);
for (let i = 0; i < 30; i++) await as(SPAM, `insert into public.reviews (rating,program,body) values (5,'기타','짧음')`);
r = await q(`select n from private.review_quota where user_id='${SPAM}'`);
ok('D24 거절된 시도 30번은 횟수에 영향 없음(n=3)', r[0].n === 3, r);
{
  const t0 = Date.now();
  r = await as(SPAM, `insert into public.reviews (rating,program,body) values (5,'기타',${B('a'.repeat(2e6))})`);
  ok('D25 2MB 본문은 곧바로 거절(23514, 3초 안)', err(r, '23514') && Date.now() - t0 < 3000, [r.ERR, Date.now() - t0]);
}

// ── 공개 조회 ──
r = await anon(`select * from public.reviews_public order by id desc`);
ok('E1 anon 뷰 조회: 칸 8개', rows(r) && Object.keys(r[0]).join() === 'id,rating,program,body,author,verified,created_at,updated_at', r && r[0] && Object.keys(r[0]));
ok('E2 최신순 9건', r.length === 9 && r[0].author === '박**', r.map((v) => v.author));
for (const [name, sql] of [
  ['표 select *', `select * from public.reviews`], ['user_id 조회', `select user_id from public.reviews`],
  ['user_id 로 걸러 보기', `select id from public.reviews where user_id = '${KIM}'`], ['user_id 로 정렬', `select id from public.reviews order by user_id`],
  ['행 전체', `select r from public.reviews r`], ['to_jsonb(행)', `select to_jsonb(r) from public.reviews r`], ['count(user_id)', `select count(user_id) from public.reviews`],
  ['hidden_reason', `select hidden_reason from public.reviews`], ['hidden_note', `select hidden_note from public.reviews`], ['verified_at', `select verified_at from public.reviews`],
  ['ctid·xmin', `select id, ctid, xmin from public.reviews`],
  ['뷰와 묶어 user_id 꺼내기', `select p.id, (select r.user_id from public.reviews r where r.id = p.id) from public.reviews_public p`],
  ['my_reviews', `select * from public.my_reviews()`], ['my_review_status', `select * from public.my_review_status()`],
  ['관리자 목록', `select * from public.admin_list_reviews()`], ['관리자 숨김', `select public.admin_set_review_hidden(${K1}, true, '기타', 'xx')`],
  ['관리자 수강 확인', `select public.admin_set_review_verified(${K1}, true)`], ['처리 기록', `select * from public.admin_list_review_log()`],
  ['프로필', `select * from public.profiles`], ['횟수 기록', `select * from private.review_quota`], ['작성 제한 표', `select * from private.review_ban`],
  ['처리 기록 표', `select * from private.review_moderation_log`], ['private 함수', `select private.review_author_label('김')`],
  ['수정', `update public.reviews set rating = 1`], ['삭제', `delete from public.reviews`], ['truncate', `truncate public.reviews`],
  ['뷰로 쓰기', `insert into public.reviews_public (rating,program,body) values (5,'기타','0123456789 anon')`],
  ['뷰로 수정', `update public.reviews_public set rating = 1`], ['뷰로 삭제', `delete from public.reviews_public`],
]) { r = await anon(sql); ok(`E3 anon ${name} 거절(42501)`, err(r, '42501'), r); }
r = await anon(`select count(*)::int c from public.reviews`);
ok('E4 anon 은 칸을 지정하면 표에서도 게시 중인 글만 센다', rows(r, 1) && r[0].c === 9, r);
for (const [name, sql] of [['user_id', `select user_id from public.reviews`], ['숨김 사유·메모', `select hidden_reason, hidden_note from public.reviews`], ['returning *', `update public.reviews set rating = 5 where id = ${L1} returning *`], ['returning user_id', `update public.reviews set rating = 1 where id = ${L1} returning user_id`]]) {
  r = await as(LEE, sql); ok(`E5 회원 ${name} 거절(42501)`, err(r, '42501'), r);
}
r = await anon(`select id, rating, program, body, author, verified, created_at, updated_at from public.reviews_public where updated_at >= now() - interval '14 days' order by updated_at asc limit 1000`);
ok('E6 모니터링 조회 모양(최근 14일, updated_at 순)', rows(r, 9), r);

// ── 수정·삭제(본인만) ──
r = await as(LEE, `update public.reviews set body='남의 글을 고쳐 봅니다 열 글자 이상' where id=${K1} returning id`);
ok('F1 남의 글 수정 0건', rows(r, 0), r);
r = await as(LEE, `delete from public.reviews where id=${K1} returning id`);
ok('F2 남의 글 삭제 0건', rows(r, 0), r);
r = await as(LEE, `update public.reviews set rating = 1 returning id`);
ok('F2b 조건 없이 전부 고치기 → 본인 글 1건만', rows(r, 1) && r[0].id === L1, r);
for (const [name, set] of [['verified', 'verified=true'], ['verified+verified_at', 'verified=true, verified_at=now()'], ['hidden_at', 'hidden_at=null'], ['author_label', `author_label='유정원'`], ['user_id', `user_id='${LEE}'`], ['created_at', `created_at=now() - interval '1 year'`], ['updated_at', 'updated_at=created_at']]) {
  r = await as(KIM, `update public.reviews set ${set} where id=${K1}`);
  ok(`F3 본인 글 ${name} 직접 쓰기 거절(42501)`, err(r, '42501'), r);
}
r = await as(KIM, `update public.profiles set is_admin = true where id = auth.uid()`);
ok('F4 관리자 권한 올리기 거절(42501)', err(r, '42501'), r);
const before = (await q(`select updated_at, created_at from public.reviews where id=${K1}`))[0];
r = await as(KIM, `update public.reviews set rating=5, body=${B(GOOD)} where id=${K1} returning updated_at`);
ok('F5 같은 값으로 저장하면 수정 시각 그대로', rows(r, 1) && T(r[0].updated_at) === T(before.updated_at), r);
r = await q(`select edits from private.review_quota where user_id='${KIM}'`);
ok('F5b 같은 값 저장은 수정 횟수에 안 들어감', r[0].edits === 0, r);
await sleep(15);
await as(KIM, `update public.profiles set name='박민수' where id='${KIM}'`);
r = await as(KIM, `update public.reviews set rating=4, body='고쳐 쓴 후기입니다. 여전히 만족합니다.' where id=${K1} returning rating, body, author_label, updated_at, created_at`);
ok('F6 본인 글 수정: 수정 시각 갱신·표시 이름 다시 계산(박**)', rows(r, 1) && r[0].rating === 4 && r[0].author_label === '박**' && T(r[0].updated_at) !== T(before.updated_at) && T(r[0].created_at) === T(before.created_at), r);
r = await as(KIM, `update public.reviews set body='짧다' where id=${K1}`);
ok('F7 수정도 길이 검사(23514)', err(r, '23514'), r);
r = await as(KIM, `update public.reviews set program='기타' where id=${K1}`);
ok('F8 이미 쓴 프로그램으로 바꾸기 거절(23505)', err(r, '23505'), r);
// 수정 횟수 제한
r = await as(EDIT, INS(5, '기타', '처음에는 무난한 글입니다 열 글자'));
const E1 = r[0].id;
let okEdits = 0, lastErr = null;
for (let i = 0; i < 22; i++) { r = await as(EDIT, `update public.reviews set body = ${B('수정 반복 ' + i + ' 번째 본문입니다 열 글자')} where id = ${E1} returning id`); if (rows(r, 1)) okEdits++; else lastErr = r; }
ok('F9 하루 수정 20번까지, 21번째부터 거절(RV006)', okEdits === 20 && err(lastErr, 'RV006', '하루에 20번'), [okEdits, lastErr]);
r = await as(EDIT, `delete from public.reviews where id = ${E1} returning id`);
ok('F10 수정 한도를 넘겨도 지우기는 됨', rows(r, 1), r);
// 이름을 지운 회원이 고칠 때
await db.exec(`update public.profiles set name = null where id='${NICK}'`);
r = await as(NICK, `update public.reviews set rating = 4 where program = '무료 자료·이벤트' returning author_label`);
ok('F11 이름이 비어 있으면 표시 이름은 그대로(행**)', rows(r, 1) && r[0].author_label === '행**', r);
await db.exec(`update public.profiles set name = '★행복한고양이' where id='${NICK}'`);

// ── 내 상태 ──
r = await as(KIM, `select * from public.my_review_status()`);
ok('G1 my_review_status: 쓸 수 있음 + 표시 이름(실명 없음)', rows(r, 1) && r[0].state === 'ok' && r[0].author === '박**' && Object.keys(r[0]).join() === 'state,author', r);
r = await as(HALF, `select * from public.my_review_status()`);
ok('G2 my_review_status: 가입 마무리 전', rows(r, 1) && r[0].state === 'onboarding' && r[0].author === null, r);
r = await as(ADM, `select * from public.my_review_status()`);
ok('G3 my_review_status: 관리자 계정', rows(r, 1) && r[0].state === 'admin', r);

// ── 관리자 ──
for (const [name, sql] of [['목록', `select * from public.admin_list_reviews()`], ['숨김', `select public.admin_set_review_hidden(${L1}, true, '기타', '마음에 안 듦')`], ['수강 확인', `select public.admin_set_review_verified(${K1}, true)`], ['처리 기록', `select * from public.admin_list_review_log()`]]) {
  r = await as(KIM, sql); ok(`H1 일반 회원 관리자 ${name} 거절(42501)`, err(r, '42501', '관리자만'), r);
}
r = await as(ADM, `select * from public.admin_list_reviews()`);
ok('H2 관리자 목록: 칸 16개, 이름·이메일·구분은 있고 휴대전화·user_id 는 없음', rows(r) && r.length === 9 && Object.keys(r[0]).length === 16 && !('phone' in r[0]) && !('user_id' in r[0]) && r.find((v) => v.id === K1).name === '박민수' && r.find((v) => v.id === K1).email === 'kim@x.com' && r.find((v) => v.id === K1).banned === false, r && r[0] && Object.keys(r[0]));
r = await as(ADM, `select public.admin_set_review_hidden(${L1}, true)`);
ok('H3 사유 없이 숨김 거절(23514)', err(r, '23514', '숨김 사유'), r);
r = await as(ADM, `select public.admin_set_review_hidden(${L1}, true, '평점 낮음')`);
ok('H4 목록에 없는 사유(평점 낮음) 거절(23514)', err(r, '23514'), r);
r = await as(ADM, `select public.admin_set_review_hidden(${L1}, true, '기타', ' ')`);
ok('H5 기타 + 메모 없음 거절(23514)', err(r, '23514', '기타 사유'), r);
r = await as(ADM, `select public.admin_set_review_hidden(999999, true, '광고·스팸')`);
ok('H6 없는 글(RV004)', err(r, 'RV004'), r);
r = await q(`select count(*)::int c from private.review_moderation_log`);
ok('H7 거절된 처리는 기록에 남지 않음', r[0].c === 0, r);
r = await anon(`select * from public.review_hidden_stats()`);
ok('H8 숨김 현황(공개): 숨긴 글이 없으면 0줄', rows(r, 0), r);
const lBefore = (await q(`select updated_at, author_label from public.reviews where id=${L1}`))[0];
r = await as(ADM, `select public.admin_set_review_hidden(${L1}, true, '개인정보 노출', '다른 사람의 연락처가 적혀 있음')`);
ok('H9 숨김 처리', rows(r), r);
r = (await q(`select hidden_at, hidden_reason, hidden_note, updated_at, author_label from public.reviews where id=${L1}`))[0];
ok('H10 숨김 기록·수정 시각과 표시 이름은 그대로', r.hidden_at && r.hidden_reason === '개인정보 노출' && r.hidden_note.includes('연락처') && T(r.updated_at) === T(lBefore.updated_at) && r.author_label === lBefore.author_label, r);
const hAt = r.hidden_at;
r = [await anon(`select id from public.reviews_public where id=${L1}`), await anon(`select id from public.reviews where id=${L1}`), await as(KIM, `select id from public.reviews where id=${L1}`), await as(LEE, `select id from public.reviews_public where id=${L1}`)];
ok('H11 숨긴 글: anon 뷰·anon 표·다른 회원·작성자의 공개 뷰 모두 0건', r.every((v) => rows(v, 0)), r);
r = await as(LEE, `select * from public.my_reviews()`);
ok('H12 작성자는 my_reviews 로 숨김 여부·사유(종류) 확인. 메모·user_id 는 없음', rows(r, 1) && r[0].hidden === true && r[0].hidden_reason === '개인정보 노출' && r[0].hidden_detail === null && !('hidden_note' in r[0]) && !('user_id' in r[0]), r);
r = await as(LEE, `select id, hidden_at is not null hidden from public.reviews where id=${L1}`);
ok('H13 작성자는 표에서 자기 숨긴 글을 찾을 수 있음(고치기·지우기용)', rows(r, 1) && r[0].hidden === true, r);
r = await as(LEE, `update public.reviews set body='개인정보를 지우고 다시 썼습니다. 피드백이 늦었어요.' where id=${L1} returning id`);
ok('H14 작성자는 숨긴 글도 고칠 수 있음', rows(r, 1), r);
r = await anon(`select id from public.reviews_public where id=${L1}`);
ok('H15 고쳐도 숨김은 유지', rows(r, 0), r);
r = await anon(`select * from public.review_hidden_stats()`);
ok('H16 숨김 현황(공개): 사유별 건수만', rows(r, 1) && r[0].reason === '개인정보 노출' && r[0].n === 1 && Object.keys(r[0]).join() === 'reason,n', r);
await sleep(15);
r = await as(ADM, `select public.admin_set_review_hidden(${L1}, true, '개인정보 노출', '다른 사람의 연락처가 적혀 있음')`);
r = await q(`select count(*)::int c from private.review_moderation_log where review_id=${L1}`);
ok('H17 같은 사유·메모로 다시 부르면 기록이 늘지 않음', r[0].c === 1, r);
r = await as(ADM, `select public.admin_set_review_hidden(${L1}, true, '기타', '저작권법 위반: 교재 본문을 통째로 옮겨 적음')`);
r = (await q(`select hidden_at, hidden_reason from public.reviews where id=${L1}`))[0];
ok('H18 사유 정정: 처음 숨긴 시각 유지', T(r.hidden_at) === T(hAt) && r.hidden_reason === '기타', r);
r = await as(LEE, `select hidden_reason, hidden_detail from public.my_reviews()`);
ok('H19 사유가 「기타」이면 작성자에게 구체 사유(메모)를 보여 줌', rows(r, 1) && r[0].hidden_reason === '기타' && /저작권법/.test(r[0].hidden_detail || ''), r);
r = await as(ADM, `select public.admin_set_review_hidden(${L1}, false, null, '작성자가 문제 부분을 지움')`);
r = (await q(`select hidden_at, hidden_reason, hidden_note from public.reviews where id=${L1}`))[0];
ok('H20 숨김 해제 → 후기의 숨김 칸 비움', r.hidden_at === null && r.hidden_reason === null && r.hidden_note === null, r);
r = await anon(`select id, rating from public.reviews_public where id=${L1}`);
ok('H21 해제 뒤 다시 공개', rows(r, 1) && r[0].rating === 1, r);
r = await as(ADM, `select public.admin_set_review_hidden(${L1}, false)`);
r = await q(`select action, rating, program, reason, note, admin_id from private.review_moderation_log where review_id=${L1} order by id`);
ok('H22 처리 기록 3줄(hide → reason → unhide), 별점·프로그램·사유·메모·처리한 관리자', r.map((v) => v.action).join() === 'hide,reason,unhide' && r.every((v) => v.rating === 1 && v.program === '학습코칭' && v.admin_id === ADM) && r[0].reason === '개인정보 노출' && r[2].reason === '기타' && r[2].note === '작성자가 문제 부분을 지움', r);
// 수강 확인
r = await as(ADM, `select public.admin_set_review_verified(${K1}, true)`);
r = (await q(`select verified, verified_at from public.reviews where id=${K1}`))[0];
ok('H23 수강 확인 표시', r.verified === true && r.verified_at, r);
ok('H24 공개 뷰에 수강 확인', (await anon(`select verified from public.reviews_public where id=${K1}`))[0].verified === true);
const vAt = T(r.verified_at);
await sleep(15);
await as(ADM, `select public.admin_set_review_verified(${K1}, true)`);
ok('H25 이미 확인한 글에 다시 표시해도 처음 시각 유지·기록 1줄', T((await q(`select verified_at from public.reviews where id=${K1}`))[0].verified_at) === vAt && (await q(`select count(*)::int c from private.review_moderation_log where review_id=${K1}`))[0].c === 1);
r = await as(KIM, `update public.reviews set body='본문만 고칩니다. 수강 확인은 그대로여야 합니다.' where id=${K1} returning verified`);
ok('H26 본문만 고치면 수강 확인 유지', rows(r, 1) && r[0].verified === true, r);
r = await as(KIM, `update public.reviews set program='생기부 컨설팅' where id=${K1} returning verified`);
ok('H27 프로그램을 바꾸면 수강 확인 해제', rows(r, 1) && r[0].verified === false && (await q(`select verified_at from public.reviews where id=${K1}`))[0].verified_at === null, r);
await as(ADM, `select public.admin_set_review_verified(${K1}, true)`);
await as(ADM, `select public.admin_set_review_verified(${K1}, false)`);
r = (await q(`select verified, verified_at from public.reviews where id=${K1}`))[0];
ok('H28 수강 확인 취소', r.verified === false && r.verified_at === null, r);
r = await as(ADM, `select public.admin_set_review_verified(${K4}, true)`);
ok('H29 무료 자료·이벤트 후기에는 수강 확인을 붙일 수 없음(23514)', err(r, '23514', '학습코칭·생기부 컨설팅'), r);
r = await as(ADM, `select public.admin_set_review_verified(${K2}, true)`);
ok('H29b 기타 후기에도 붙일 수 없음(23514)', err(r, '23514'), r);
r = await as(ADM, `update public.reviews set hidden_at=now(), hidden_reason='기타', hidden_note='직접' where id=${L1} returning id`);
ok('H30 관리자도 표를 직접 고칠 수는 없음(함수로만)', err(r, '42501'), r);
r = await as(ADM, `delete from public.reviews where id=${L1} returning id`);
ok('H31 관리자도 남의 글을 지울 수 없음(0건)', rows(r, 0), r);
r = await as(ADM, `select * from public.admin_list_review_log()`);
ok('H32 처리 기록 목록(관리자): 칸 9개, 작성자 정보 없음', rows(r) && r.length === 6 && Object.keys(r[0]).join() === 'at,review_id,action,rating,program,reason,note,admin_email,deleted' && r[0].admin_email === 'adm@x.com' && r.every((v) => v.deleted === false), r && r[0]);

// ── 숨김을 지우고 다시 올리기 · 작성 제한 ──
r = await as(BAN, INS(1, '기타', '전화번호 010-1234-5678 로 연락 주세요 광고'));
const B1 = r[0].id;
await as(ADM, `select public.admin_set_review_hidden(${B1}, true, '광고·스팸', '후기와 관계없는 광고')`);
r = await as(BAN, `delete from public.reviews where id=${B1} returning id`);
ok('I1 작성자는 숨긴 글을 지울 수 있음', rows(r, 1), r);
r = await as(ADM, `select action, deleted from public.admin_list_review_log() where review_id = ${B1}`);
ok('I2 글을 지워도 처리 기록은 남고 「지워진 글」로 표시', rows(r, 1) && r[0].action === 'hide' && r[0].deleted === true, r);
r = await as(ADM, `select public.admin_set_review_hidden(${B1}, false)`);
ok('I3 지워진 글의 숨김 해제 → RV004', err(r, 'RV004'), r);
r = await as(BAN, INS(1, '기타', '전화번호 010-1234-5678 로 연락 주세요 광고'));
ok('I4 (알려진 한계) 지우고 같은 내용을 다시 올리면 새 번호로 게시됨', rows(r, 1) && r[0].hidden_at === null, r);
const B2 = r[0].id;
await db.exec(`insert into private.review_ban (user_id, reason) values ('${BAN}', '숨김 처리된 광고 글을 되풀이해 올림')`);
r = await as(BAN, INS(1, '학습코칭', '제한된 뒤에 새 글을 올려 봅니다 열 글자'));
ok('I5 작성 제한 계정: 새 글 거절(RV005)', err(r, 'RV005', '제한된 계정'), r);
r = await as(BAN, `update public.reviews set body='제한된 뒤에 내용을 고쳐 봅니다 열 글자' where id=${B2} returning id`);
ok('I6 작성 제한 계정: 내용 수정 거절(RV005)', err(r, 'RV005'), r);
r = await as(BAN, `select * from public.my_review_status()`);
ok('I7 my_review_status: 작성 제한', rows(r, 1) && r[0].state === 'banned', r);
r = await as(ADM, `select banned from public.admin_list_reviews() where id = ${B2}`);
ok('I8 관리자 목록에 작성 제한 표시', rows(r, 1) && r[0].banned === true, r);
r = await as(ADM, `select public.admin_set_review_hidden(${B2}, true, '광고·스팸')`);
ok('I9 작성 제한 계정의 글도 관리자는 숨길 수 있음', rows(r) && (await anon(`select id from public.reviews_public where id=${B2}`)).length === 0, r);
r = await as(BAN, `delete from public.reviews where id=${B2} returning id`);
ok('I10 작성 제한 계정: 지우기는 됨', rows(r, 1), r);
r = await as(BAN, `insert into private.review_ban (user_id, reason) values ('${KIM}', '남을 제한해 봅니다')`);
ok('I11 회원이 작성 제한 표에 쓰기 거절', err(r, '42501'), r);
await db.exec(`delete from private.review_ban where user_id='${BAN}'`);
r = await as(BAN, `select state from public.my_review_status()`);
ok('I12 제한을 풀면 다시 쓸 수 있는 상태', rows(r, 1) && r[0].state === 'ok', r);

// ── 다시 실행(데이터가 있는 상태) ──
await as(ADM, `select public.admin_set_review_hidden(${K2}, true, '광고·스팸')`);
await as(ADM, `select public.admin_set_review_verified(${K1}, true)`);
await db.exec(`insert into private.review_ban (user_id, reason) values ('${SPAM}', '시험용 제한')`);
const snap = async () => JSON.stringify([await q(`select * from public.reviews order by id`), await q(`select * from private.review_quota order by user_id`), await q(`select * from private.review_moderation_log order by id`), await q(`select * from private.review_ban order by user_id`)]);
const s1 = await snap();
r = [await x(R), await x(R)];
ok('J1 데이터가 있는 상태에서 2회 더 실행', r.every((v) => v === 'ok'), r);
ok('J2 후기·숨김·수강 확인·횟수·처리 기록·작성 제한 그대로', (await snap()) === s1);
r = [(await q(`select count(*)::int c from pg_policy where polrelid='public.reviews'::regclass`))[0].c, (await q(`select count(*)::int c from pg_trigger where tgrelid='public.reviews'::regclass and not tgisinternal`))[0].c, (await q(`select count(*)::int c from cron.job where jobname like 'snucoach-purge-review%'`))[0].c];
ok('J3 정책 5·트리거 3·정리 작업 1 유지', r.join() === '5,3,1', r);
r = (await q(`select column_name from information_schema.column_privileges where table_schema='public' and table_name='reviews' and grantee='anon' and privilege_type='SELECT' order by 1`)).map((v) => v.column_name).join();
ok('J4 다시 실행해도 anon 이 읽을 수 있는 칸은 같음', r === 'author_label,body,created_at,hidden_at,id,program,rating,updated_at,verified', r);
const pubCount = (await anon(`select count(*)::int c from public.reviews_public`))[0].c;
ok('J5 다시 실행 뒤에도 공개 조회 동작', pubCount === (await q(`select count(*)::int c from public.reviews where hidden_at is null`))[0].c, pubCount);
await db.exec(`delete from private.review_ban`);

// ── 휴대전화 파일을 나중에 실행 ──
ok('K1 phone.sql·enforce.sql 을 후기 뒤에 실행', (await x(P)) === 'ok' && (await x(E)) === 'ok');
await as(KIM, `update public.profiles set phone='010-1234-5678' where id='${KIM}'`);
r = await as(ADM, `select * from public.admin_list_reviews() limit 1`);
ok('K2 휴대전화 번호가 생겨도 후기 관리 목록에는 나오지 않음', rows(r, 1) && !JSON.stringify(r).includes('01012345678') && !('phone' in r[0]), r);
ok('K3 그 뒤 reviews.sql 다시 실행', (await x(R)) === 'ok');
await db.exec(`update private.review_quota set day = day - 1`);
r = await as(LEE, INS(5, '기타', GOOD));
ok('K4 번호 없는 회원도 후기를 쓸 수 있음', rows(r, 1), r);
r = await anon(`select * from public.reviews_public limit 1`);
ok('K5 공개 뷰 칸은 그대로 8개', Object.keys(r[0]).length === 8, Object.keys(r[0]));

// ── 탈퇴 ──
r = await as(LEE, `select public.delete_my_account()`);
ok('L1 탈퇴(숨김 처리 기록이 있는 회원)', rows(r), r);
r = await q(`select (select count(*)::int from public.reviews where user_id='${LEE}') rv, (select count(*)::int from private.review_quota where user_id='${LEE}') qt, (select count(*)::int from auth.users where id='${LEE}') u`);
ok('L2 탈퇴하면 계정·후기·횟수 기록 삭제', r[0].rv === 0 && r[0].qt === 0 && r[0].u === 0, r);
r = await q(`select count(*)::int c from private.review_moderation_log where review_id=${L1}`);
ok('L3 처리 기록은 남는다(작성자 정보 없이)', r[0].c === 3, r);
await db.exec(`insert into private.review_ban (user_id, reason) values ('${EN}', '시험용 제한')`);
r = await as(EN, `select public.delete_my_account()`);
ok('L4 작성 제한 계정도 탈퇴할 수 있고 제한 기록이 함께 삭제됨', rows(r) && (await q(`select count(*)::int c from private.review_ban`))[0].c === 0, r);
r = await as(ADM, `select public.delete_my_account()`);
ok('L5 처리 기록을 남긴 관리자 계정이 지워져도 기록은 남음(관리자 이메일만 비어 나옴)', rows(r) && (await q(`select count(*)::int c from private.review_moderation_log`))[0].c > 0, r);

// ── 정리 작업 ──
await db.exec(`update private.review_quota set day = day - 2`);
await db.exec(`update private.review_moderation_log set at = now() - interval '3 years 1 day' where review_id = ${L1}`);
const left = (await q(`select count(*)::int c from private.review_moderation_log where review_id <> ${L1}`))[0].c;
const job = (await q(`select command from cron.job where jobname='snucoach-purge-review-records'`))[0].command;
ok('M1 정리 작업 SQL 실행', (await x(job)) === 'ok');
r = await q(`select (select count(*)::int from private.review_quota) qt, (select count(*)::int from private.review_moderation_log) lg`);
ok('M2 지난 날의 횟수 기록과 3년 지난 처리 기록만 삭제', r[0].qt === 0 && r[0].lg === left && left > 0, [r, left]);

// ── SQL Editor(로그인 정보 없음) ──
r = await q(`insert into public.reviews (user_id, rating, program, body, created_at) values ('${NICK}', 5, '학습코칭', '백업에서 되살린 후기입니다. 열 글자 이상.', '2026-09-01T00:00:00Z') returning author_label, created_at, updated_at`);
ok('N1 SQL Editor 로 넣은 글(백업 복구): 표시 이름 계산·작성일 유지', rows(r, 1) && r[0].author_label === '행**' && new Date(r[0].created_at).toISOString().startsWith('2026-09-01') && T(r[0].created_at) === T(r[0].updated_at), r);

// ── 표시 이름 ──
{
  const want = [['김철수', '김**'], ['이영', '이**'], ['남궁민수', '남**'], ['김', '김**'], [' 김철수 ', '김**'], ['김 철수', '김**'], ['john smith', 'J**'], ['Zoe', 'Z**'], ['7기 민수', '7**'],
    ['★행복한고양이', '행**'], ['🙂맘', '맘**'], ['(주)스누', '주**'], ['田中', '田**'], ['たなか', 'た**'], ['タナカ', 'タ**'], ['élodie', 'L**'],
    ['🙂🙂', '회원'], ['', '회원'], ['   ', '회원'], ['ㅋㅋ', '회원'], ['-_-', '회원'], ['ᄀ', '회원']];
  const bad = [];
  for (const [n, w] of want) { const d = (await db.query(`select private.review_author_label($1) v`, [n])).rows[0].v; if (d !== w) bad.push([n, d, w]); }
  bad.push(...((await q(`select private.review_author_label(null) v`))[0].v === '회원' ? [] : [['null']]));
  ok(`O1 표시 이름 규칙 (${want.length + 1}건)`, bad.length === 0, bad);
}

// ── 본문 정리: SQL 과 화면(reviews.js)의 실제 코드가 같은 결과인지 ──
{
  const js = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'reviews.js'), 'utf8');
  const a = js.indexOf('// ── 순수 함수(시작)'), b = js.indexOf('// ── 순수 함수(끝)');
  ok('P0 reviews.js 에서 순수 함수 구간을 찾음', a > 0 && b > a, [a, b]);
  const { cleanBody, bodyLength } = new Function(js.slice(a, b) + '\nreturn { cleanBody, bodyLength };')();
  const cases = {
    '앞뒤 공백': '  앞뒤 공백  ', '줄바꿈 통일': '줄1\r\n줄2\r줄3', '빈 줄 여러 개': 'a\n\n\n\nb', '공백만 있는 줄': 'a\n \n \nb', '탭': 'tab\there',
    '폭 없는 공백·BOM·방향 문자': '보이지\u200B않는\uFEFF글자\u202E', '제어 문자': 'a\u0001b\u007Fc\u0085d', '시작과 끝의 빈 줄': '\n\n시작과 끝\n\n', '이모지': '이모지 🙂 포함 열 글자 넘김',
    '하이픈 보존': 'a-b-c 2026-10-03 010-1234-5678', '폭 없는 공백 9개': 'a' + '\u200B'.repeat(9), 'BOM 9개': 'a' + '\uFEFF'.repeat(9), '방향 문자': 'abc\u202Edef\u2066ghi\u2069',
    '한글 채움 문자': '\u3164'.repeat(10) + '가', '반각 한글 채움': '\uFFA0'.repeat(10), '초성·중성 채움': '\u115F\u1160'.repeat(5), '부드러운 하이픈': 'a' + '\u00AD'.repeat(9), '변형 선택자': 'a' + '\uFE0F'.repeat(9),
    'CGJ': 'a' + '\u034F'.repeat(9), '줄 구분자': 'a\u2028b\u2029c', '줄바꿈 금지 공백': 'a\u00A0b\u202Fc', '전각 공백': 'a\u3000b', '점자 빈칸': 'a\u2800b', '태그 문자': 'a' + '\u{E0020}\u{E007F}'.repeat(5) + 'b',
    '결합 기호 2개는 보존': 'e\u0301\u0302 정상', '결합 기호 3개부터 삭제': 'a' + '\u0301'.repeat(3) + 'b' + '\u0489'.repeat(50), '500줄': 'a\n'.repeat(500), '일반 글': '좋았어요.\r\n\r\n\r\n다음에도\t이용할게요  ',
    '주석 문자': 'a\uFFF9b\uFFFAc\uFFFBd', '한 줄 두 줄': '한 줄\n두 줄',
  };
  const bad = [], out = {};
  for (const [k, v] of Object.entries(cases)) {
    const d = (await db.query(`select private.review_clean_body($1) v, char_length(private.review_clean_body($1)) n`, [v])).rows[0];
    out[k] = d.v;
    if (d.v !== cleanBody(v) || d.n !== bodyLength(v)) bad.push([k, d.v, cleanBody(v), d.n, bodyLength(v)]);
  }
  ok(`P1 본문 정리·글자 수: SQL = reviews.js (${Object.keys(cases).length}건)`, bad.length === 0, bad);
  ok('P2 하이픈 보존', out['하이픈 보존'] === 'a-b-c 2026-10-03 010-1234-5678', out['하이픈 보존']);
  ok('P3 폭 없는 공백·BOM·방향 문자·채움 문자·태그 문자 제거', out['폭 없는 공백 9개'] === 'a' && out['BOM 9개'] === 'a' && out['방향 문자'] === 'abcdefghi' && out['한글 채움 문자'] === '가' && out['반각 한글 채움'] === '' && out['초성·중성 채움'] === '' && out['태그 문자'] === 'ab' && out['변형 선택자'] === 'a' && out['부드러운 하이픈'] === 'a', out);
  ok('P4 특수 공백은 공백으로', out['줄 구분자'] === 'a b c' && out['줄바꿈 금지 공백'] === 'a b c' && out['전각 공백'] === 'a b' && out['점자 빈칸'] === 'a b', out);
  ok('P5 결합 기호: 2개까지 보존, 3개 이상 삭제', out['결합 기호 2개는 보존'] === 'e\u0301\u0302 정상' && out['결합 기호 3개부터 삭제'] === 'ab', [out['결합 기호 2개는 보존'], out['결합 기호 3개부터 삭제']]);
  r = (await db.query(`select private.review_clean_body(private.review_clean_body($1)) = private.review_clean_body($1) v`, ['  a\r\n\r\n\r\n b \t\n\u00A0'])).rows[0];
  ok('P6 본문 정리는 두 번 해도 같은 결과', r.v === true, r);
  ok('P7 화면의 JS 는 NUL 문자도 공백으로 바꿈(DB 는 NUL 을 받지 못한다)', cleanBody('a\u0000b') === 'a b');
}

// ── 되돌리기 ──
ok('Q1 되돌리기 SQL', (await x(RB)) === 'ok');
ok('Q2 되돌린 뒤 객체 목록이 후기 적용 전과 같음(phone.sql 이 더한 것 제외하고 후기 것 0개)', !/review/.test(await objs()), (await objs()).match(/[a-z_]*review[a-z_]*/g));
r = await q(`select name from public.profiles where id='${KIM}'`);
ok('Q3 되돌린 뒤 회원 정보 그대로', r[0] && r[0].name === '박민수', r);
ok('Q4 되돌리기 두 번 실행해도 오류 없음', (await x(RB)) === 'ok');
ok('Q5 다시 적용', (await x(R)) === 'ok');
ok('Q6 다시 적용하면 빈 표', (await anon(`select count(*)::int c from public.reviews_public`))[0].c === 0);
await db.exec(`drop schema cron cascade`);
ok('Q7 cron 스키마 없이 실행해도 통과(정리 작업만 건너뜀)', (await x(R)) === 'ok');
{
  const h = await boot();
  await h.x(M1);
  const before = JSON.stringify([await h.q(`select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') order by 1,2`), await h.q(`select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') order by 1,2`), await h.q(`select jobname from cron.job order by 1`)]);
  await h.x(R); await h.x(RB);
  const after = JSON.stringify([await h.q(`select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') order by 1,2`), await h.q(`select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') order by 1,2`), await h.q(`select jobname from cron.job order by 1`)]);
  ok('Q8 적용 → 되돌리기 뒤 public·private 객체와 정리 작업이 적용 전과 같음', before === after);
}
void objsBefore;

console.log(fail ? `\n${fail} FAILED / ${total}` : `\nALL PASSED (${total})`);
process.exit(fail ? 1 : 0);
