-- ============================================================
-- 스누코치 — 회원 후기
--
-- 사용법: 20261001000000_members.sql 을 먼저 실행한 뒤, 이 파일 전체를 SQL Editor 에 붙여 넣고 Run.
--         여러 번 실행해도 같은 결과가 된다. 이미 쓰인 후기와 숨김·수강 확인·처리 기록은 그대로 둔다.
--         휴대전화용 파일(20261002000000_phone.sql, 20261002010000_phone_alert_enforce.sql)을 실행했는지와
--         관계없이 실행할 수 있고, 그 파일들을 이 파일보다 나중에 실행해도 된다(휴대전화 번호를 쓰지 않는다).
--         사이트 배포보다 먼저 실행한다. 사이트를 먼저 배포하면 후기 페이지의 「회원 후기」 구역이
--         숨겨진 채로 있다가, 이 파일을 실행한 뒤부터 나타난다(다른 화면은 영향이 없다).
--
-- 만드는 것
--   1) public.reviews               회원 후기(별점 1~5 · 이용 프로그램 · 본문 10~1,000자). 한 회원이 프로그램마다 1개
--   2) 표시 이름 · 본문 정리         이름의 첫 글자만 남긴 값(예: 김**)과 정리한 본문을 서버가 만든다
--   3) 작성·수정·삭제 트리거         가입 마무리 확인, 관리자·작성 제한 계정 거절, 하루 새 글 3건·수정 20번 제한,
--                                   숨김 처리된 글을 지우면 14일 동안 새 글 보류
--   4) 행 수준 보안(RLS)·열 권한     읽기: 숨기지 않은 후기만 누구나 / 쓰기·수정·삭제: 본인만(별점·프로그램·본문 칸만)
--   5) public.reviews_public        공개 조회용 뷰(가린 이름·수강 확인·프로그램·별점·본문·작성/수정 일시만)
--   6) public.review_hidden_stats() 숨김 처리된 후기의 사유별 건수(공개. 후기 페이지의 운영 기준 안내에 적는다)
--   7) public.my_reviews() · public.my_review_status()   내가 쓴 후기, 내가 후기를 쓸 수 있는 상태인지
--   8) 관리자 함수                   admin_list_reviews() · admin_set_review_hidden() · admin_set_review_verified()
--                                   · admin_log_review_notice() · admin_list_review_log()
--   9) private.review_moderation_log  숨김·해제·수강 확인·작성자 알림 처리 기록(추가만 한다. 작성자·본문은 담지 않는다. 3년 보관)
--  10) private.review_ban           후기 작성 제한 계정(SQL Editor 에서만 넣고 뺀다)
--  11) private.review_hold          숨김 처리된 글을 스스로 지운 회원의 새 글 보류(14일)
--  12) 표시 이름 맞추기              프로필 이름을 바꾸면 그 회원의 모든 후기의 표시 이름을 함께 바꾼다
--  13) 매일 정리 작업                지난 날의 작성 횟수 기록, 끝난 보류, 3년 지난 처리 기록 삭제와
--                                   임시 조치(권리 침해 신고)로 숨긴 지 29일이 지난 후기의 자동 재게시(pg_cron)
--
-- 공개 조회(로그인 없이, 공개 키만으로)로는 user_id · 실명 · 이메일 · 휴대전화 번호 · 숨김 사유와 메모를 읽을 수 없다.
-- 탈퇴하면 그 회원의 후기와 작성 횟수 기록·작성 제한 기록·보류 기록이 함께 삭제된다(on delete cascade).
-- 그래서 작성 제한과 보류는 탈퇴한 뒤 다시 가입하면 풀린다(supabase/README.md 9-3 의 「남은 위험」).
-- ============================================================
begin;

-- ── 0) 선행 조건 ──────────────────────────────────────────
do $guard$
begin
  if to_regclass('public.profiles') is null or to_regnamespace('private') is null
     or to_regprocedure('private.is_admin()') is null then
    raise exception '20261001000000_members.sql 을 먼저 실행해 주세요.';
  end if;
  -- 공개 조회용 뷰가 「조회하는 사람의 권한」으로 실행되려면 PostgreSQL 15 이상이어야 한다(security_invoker).
  if current_setting('server_version_num')::integer < 150000 then
    raise exception 'PostgreSQL 15 이상이 필요합니다(지금 %). 적용하지 않았습니다.', current_setting('server_version');
  end if;
end $guard$;

-- ── 1) 후기 표 ────────────────────────────────────────────
create table if not exists public.reviews (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rating        smallint not null,                    -- 별점 1~5
  program       text not null,                        -- 이용한 프로그램
  body          text not null,                        -- 본문(정리한 뒤 10~1,000자)
  author_label  text not null default '회원',          -- 공개 표시 이름(예: 김**). 서버가 만든다
  verified      boolean not null default false,       -- 수강 확인(관리자만 바꾼다)
  verified_at   timestamptz,
  hidden_at     timestamptz,                          -- 숨김 처리 시각(null 이면 게시 중). 관리자만 바꾼다
  hidden_reason text,                                 -- 숨김 사유(운영 기준)
  hidden_note   text,                                 -- 숨김 메모(작성자에게 구체 사유로 보인다)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()    -- 작성자가 내용을 마지막으로 고친 시각(고친 적 없으면 created_at 과 같다)
);

comment on table public.reviews is '회원 후기. 쓰면 바로 게시되고, 운영 기준을 위반한 후기만 관리자가 사유를 기록하고 숨긴다. 탈퇴하면 함께 삭제된다.';
comment on column public.reviews.author_label is '공개 표시 이름. 프로필 이름의 첫 글자 + ** (private.review_author_label). 실명은 저장하지 않는다.';
comment on column public.reviews.hidden_reason is '숨김 사유(약관 제10조 제5항 각 호와 제8항): 욕설·인신공격 / 광고·스팸 / 개인정보 노출 / 허위 사실·권리 침해 / 법령 위반(메모 필수) / 임시 조치(권리 침해 신고)(메모 필수, 30일 안에 정한다). 평점이 낮다는 이유로는 숨기지 않는다.';
comment on column public.reviews.verified is '수강 확인. 학습코칭·생기부 컨설팅 후기에만, 수강 기록과 대조해 확인된 경우에 붙인다.';

alter table public.reviews drop constraint if exists reviews_rating_range;
alter table public.reviews add constraint reviews_rating_range
  check (rating between 1 and 5);

alter table public.reviews drop constraint if exists reviews_program_allowed;
alter table public.reviews add constraint reviews_program_allowed
  check (program in ('학습코칭', '생기부 컨설팅', '무료 자료·이벤트', '기타'));

alter table public.reviews drop constraint if exists reviews_body_length;
alter table public.reviews add constraint reviews_body_length
  check (char_length(body) between 10 and 1000 and body = btrim(body, E' \n'));

alter table public.reviews drop constraint if exists reviews_author_label_length;
alter table public.reviews add constraint reviews_author_label_length
  check (char_length(author_label) between 1 and 10);

alter table public.reviews drop constraint if exists reviews_verified_consistent;
alter table public.reviews add constraint reviews_verified_consistent
  check (verified = (verified_at is not null));

-- 수강 확인은 수강하는 프로그램(학습코칭 · 생기부 컨설팅)의 후기에만 붙는다.
alter table public.reviews drop constraint if exists reviews_verified_program;
alter table public.reviews add constraint reviews_verified_program
  check (not verified or program in ('학습코칭', '생기부 컨설팅'));

-- 숨김 사유의 이름은 약관 제10조 제5항 각 호와 맞춘다(공개되는 숨김 현황·작성자 화면·안내 메일에 그대로 나온다).
-- 「법령 위반」과 「임시 조치(권리 침해 신고)」는 메모(구체 사유)가 필수다.
alter table public.reviews drop constraint if exists reviews_hidden_consistent;
-- (이 파일의 옛 판을 실행한 적이 있는 경우에만 해당) 옛 사유 이름을 새 이름으로 옮긴다. 수정 트리거는 내용이 바뀌지 않으면 아무것도 하지 않는다.
update public.reviews set hidden_reason = '욕설·인신공격' where hidden_reason = '욕설·비방';
update public.reviews set hidden_reason = '법령 위반' where hidden_reason = '기타';
alter table public.reviews add constraint reviews_hidden_consistent
  check (
    (hidden_at is null and hidden_reason is null and hidden_note is null)
    or (hidden_at is not null
        and hidden_reason in ('욕설·인신공격', '광고·스팸', '개인정보 노출', '허위 사실·권리 침해', '법령 위반', '임시 조치(권리 침해 신고)')
        and (hidden_note is null or char_length(hidden_note) between 1 and 300)
        and (hidden_reason not in ('법령 위반', '임시 조치(권리 침해 신고)') or char_length(coalesce(hidden_note, '')) >= 2))
  );

-- 글 번호 시퀀스는 API 역할이 직접 만질 일이 없다(Supabase 기본값은 public 의 새 시퀀스를 anon·authenticated 에게 연다).
-- 회수해도 글 작성에는 영향이 없다(identity 칸의 번호는 표의 소유자 권한으로 매겨진다).
do $seq$
begin
  execute format('revoke all on sequence %s from anon, authenticated', pg_get_serial_sequence('public.reviews', 'id'));
end $seq$;

-- 한 회원이 프로그램마다 후기 1개(고쳐 쓸 수 있다)
create unique index if not exists reviews_user_program_key on public.reviews (user_id, program);

-- ── 2) 표시 이름: 이름에서 처음 나오는 글자(한글·영문·숫자·한자·가나) 하나 + ** ──
-- 글자 판정은 코드 값으로 한다(정규식의 글자 범위는 DB 로캘에 따라 달라질 수 있다).
create or replace function private.review_author_label(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := btrim(coalesce(p_name, ''));
  c text;
  n integer;
begin
  for i in 1 .. char_length(v) loop
    c := substr(v, i, 1);
    n := ascii(c);
    if (n between 44032 and 55203)                                      -- 한글 음절(가~힣)
       or (n between 65 and 90) or (n between 97 and 122)               -- 영문
       or (n between 48 and 57)                                         -- 숫자
       or (n between 19968 and 40959)                                   -- 한자
       or (n between 12353 and 12438) or (n between 12449 and 12538)    -- 가나
    then
      return upper(c) || '**';
    end if;
  end loop;
  return '회원';
end;
$$;

revoke all on function private.review_author_label(text) from public;

-- 본문 정리. assets/js/reviews.js 의 cleanBody() 와 같은 규칙이다(둘을 함께 고친다).
--   ① 줄바꿈을 \n 으로 통일
--   ② 제어 문자와 특수 공백(줄·문단 구분자, 전각 공백, 점자 공백 등)은 공백 한 칸으로
--   ③ 보이지 않는 글자(폭 없는 공백, 글 방향 제어 문자, 한글 채움 문자, 변형 선택자, 태그 문자 등)는 삭제
--   ④ 한 글자에 3개 이상 겹쳐 붙인 결합 기호(라틴·키릴·히브리·아랍·태국 문자용)는 삭제(글자를 위아래로 번지게 하는 장난 방지)
--   ⑤ 빈 줄은 한 줄까지, 앞뒤 공백·줄바꿈 삭제
-- 보이지 않는 글자는 반드시 \u 이스케이프로 적는다. 글자 그대로 적으면 옮겨 적다가 빠져도 오류가 나지 않고
-- 규칙만 달라진다(예: 하이픈이 전부 지워진다).
create or replace function private.review_clean_body(p_body text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(coalesce(p_body, ''), '\r\n?', E'\n', 'g'),
              '[\u0001-\u0009\u000B-\u001F\u007F-\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u2800\u3000]', ' ', 'g'),
            '[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]', '', 'g'),
          '[\U000E0000-\U000E0FFF]', '', 'g'),
        '[\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u064B-\u065F\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]{3,}', '', 'g'),
      '\n[ \n]*\n', E'\n\n', 'g'),
    E' \n');
$$;

revoke all on function private.review_clean_body(text) from public;

-- ── 3) 작성 빈도 제한 · 작성 제한 계정 · 보류 · 처리 기록 ─────
-- 회원 한 명당 하루(한국 날짜) 새 후기 3건, 수정 20번. 쓰고 지우기를 되풀이해도 횟수는 줄지 않는다.
-- 회원당 한 줄(마지막으로 쓰거나 고친 날짜와 그날 횟수)만 둔다. API 로는 보이지 않는 private 스키마에 둔다.
create table if not exists private.review_quota (
  user_id uuid primary key references auth.users (id) on delete cascade,
  day     date not null,
  n       integer not null default 0,   -- 그날 올린 새 후기 수
  edits   integer not null default 0    -- 그날 고친 횟수
);
alter table private.review_quota enable row level security;
revoke all on table private.review_quota from public, anon, authenticated;

-- 후기 작성 제한 계정. 운영 기준을 되풀이해 위반한 회원(약관 제10조)을 SQL Editor 에서 넣고 뺀다.
-- 이 표에 있는 회원은 새 후기를 쓰거나 후기 내용을 고칠 수 없다(지우기는 된다).
create table if not exists private.review_ban (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  reason     text not null check (char_length(btrim(reason)) between 2 and 300),
  created_at timestamptz not null default now()
);
alter table private.review_ban enable row level security;
revoke all on table private.review_ban from public, anon, authenticated;

-- 새 글 보류. 숨김 처리된 자기 글을 스스로 지운 회원은 14일 동안 새 후기를 올릴 수 없다(약관 제10조 제10항).
-- 숨긴 글을 지우고 같은 내용을 새 글로 올려 숨김 처리를 없던 일로 만드는 것을 막는다.
-- 숨김 처리된 글을 고쳐서 다시 게시를 요청하는 길과, 이미 올린 다른 글을 고치고 지우는 것은 그대로 된다.
-- 회원당 한 줄(보류가 끝나는 시각)만 둔다. 끝난 보류는 정리 작업이 지운다. 미리 풀 때는 SQL Editor 에서 지운다.
create table if not exists private.review_hold (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  until      timestamptz not null,
  created_at timestamptz not null default now()
);
alter table private.review_hold enable row level security;
revoke all on table private.review_hold from public, anon, authenticated;

-- 처리 기록: 관리자가 후기를 숨기거나, 사유를 고치거나, 숨김을 해제하거나, 수강 확인을 붙이고 떼거나,
-- 작성자에게 안내 메일을 보냈다고 적은 일을 한 줄씩 남긴다. 임시 조치의 자동 재게시도 남는다(관리자 칸이 비어 있다).
-- 추가만 하고 고치지 않는다. 작성자(user_id)와 본문은 담지 않는다: 후기가 지워진 뒤에도
-- 「운영 기준에 따라서만 숨겼다」는 것을 보일 수 있게 남기되, 누구의 글이었는지는 알 수 없게 한다.
-- 처리한 날부터 3년 뒤 지운다(아래 정리 작업).
create table if not exists private.review_moderation_log (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  review_id bigint not null,       -- 글 번호(후기가 지워져도 남는다. 참조 제약을 걸지 않는다)
  action    text not null,         -- hide · reason · unhide · verify · unverify · notify(작성자에게 알렸다는 기록)
  rating    smallint,              -- 처리할 때의 별점
  program   text,                  -- 처리할 때의 프로그램
  reason    text,                  -- 숨김 사유(해제 기록에는 해제 전 사유)
  note      text,                  -- 메모(알림 기록에는 어떤 안내였는지)
  admin_id  uuid                   -- 처리한 관리자 계정
);
alter table private.review_moderation_log enable row level security;
revoke all on table private.review_moderation_log from public, anon, authenticated;
create index if not exists review_moderation_log_review_idx on private.review_moderation_log (review_id, id);
alter table private.review_moderation_log drop constraint if exists review_moderation_log_action_check;
-- (옛 판을 실행한 적이 있는 경우에만 해당) 옛 사유 이름을 새 이름으로 옮긴다
update private.review_moderation_log set reason = '욕설·인신공격' where reason = '욕설·비방';
update private.review_moderation_log set reason = '법령 위반' where reason = '기타';
alter table private.review_moderation_log add constraint review_moderation_log_action_check
  check (action in ('hide', 'reason', 'unhide', 'verify', 'unverify', 'notify'));

-- 작성 전: 작성자·게시 상태·시각은 서버가 정한다. 가입 마무리 전 회원, 관리자 계정, 작성 제한 계정, 보류 중인 계정은 거절한다.
create or replace function private.reviews_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text;
  v_done  boolean;
  v_until timestamptz;
begin
  -- 회원이 API 로 쓰는 글. (SQL Editor 처럼 로그인 정보가 없는 실행은 넣은 값을 그대로 둔다. 백업 복구용이다.)
  if v_uid is not null then
    new.user_id       := v_uid;
    new.verified      := false;
    new.verified_at   := null;
    new.hidden_at     := null;
    new.hidden_reason := null;
    new.hidden_note   := null;
    new.created_at    := now();
    -- 운영자가 회원인 것처럼 후기를 쓰지 않는다.
    if private.is_admin() then
      raise exception '관리자 계정으로는 후기를 쓸 수 없습니다.' using errcode = 'RV003';
    end if;
    if exists (select 1 from private.review_ban b where b.user_id = v_uid) then
      raise exception '후기 작성이 제한된 계정입니다. 이의가 있으면 카카오톡 채널로 알려 주세요.' using errcode = 'RV005';
    end if;
    select h.until into v_until from private.review_hold h where h.user_id = v_uid and h.until > now();
    if found then
      raise exception '숨김 처리된 후기를 지운 뒤 14일 동안은 새 후기를 올릴 수 없습니다(% 까지).',
        to_char(v_until at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') using errcode = 'RV007';
    end if;
  end if;
  new.updated_at := new.created_at;
  new.body := private.review_clean_body(new.body);

  select p.name,
         (p.name is not null and p.member_type is not null and p.grade is not null
           and p.terms_agreed_at is not null and p.privacy_agreed_at is not null
           and p.age_confirmed_at is not null)
    into v_name, v_done
  from public.profiles p
  where p.id = new.user_id;

  if v_uid is not null and not coalesce(v_done, false) then
    raise exception '가입 마무리를 끝낸 뒤 후기를 남길 수 있습니다.' using errcode = 'RV002';
  end if;
  new.author_label := private.review_author_label(v_name);

  return new;
end;
$$;

revoke all on function private.reviews_before_insert() from public;

drop trigger if exists reviews_before_insert on public.reviews;
create trigger reviews_before_insert
  before insert on public.reviews
  for each row execute function private.reviews_before_insert();

-- 작성 뒤: 실제로 들어간 글만 그날 횟수에 넣는다(거절되거나 on conflict 로 건너뛴 요청은 세지 않는다).
-- 넘으면 그 요청 전체를 되돌린다.
create or replace function private.reviews_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  v_n   integer;
begin
  if v_uid is null then
    return null;
  end if;
  insert into private.review_quota as q (user_id, day, n, edits)
  values (v_uid, v_day, 1, 0)
  on conflict (user_id) do update
    set n     = case when q.day = excluded.day then q.n + 1 else 1 end,
        edits = case when q.day = excluded.day then q.edits else 0 end,
        day   = excluded.day
  returning q.n into v_n;
  if v_n > 3 then
    raise exception '후기는 하루에 3건까지 쓸 수 있습니다. 내일 다시 시도해 주세요.' using errcode = 'RV001';
  end if;
  return null;
end;
$$;

revoke all on function private.reviews_after_insert() from public;

drop trigger if exists reviews_after_insert on public.reviews;
create trigger reviews_after_insert
  after insert on public.reviews
  for each row execute function private.reviews_after_insert();

-- 수정: 작성자는 별점·프로그램·본문만 고친다(열 권한). 숨김·수강 확인은 관리자 함수만 바꾼다.
-- 내용(별점·프로그램·본문)은 작성자 본인만 바꾼다. 관리자 함수와 정리 작업은 내용을 건드리지 않으므로
-- 본문 정리·작성 제한·수정 횟수 검사는 내용이 바뀔 때만 한다(관리자의 숨김 처리가 「작성자 수정」으로 세어지지 않게).
create or replace function private.reviews_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_day   date := (now() at time zone 'Asia/Seoul')::date;
  v_name  text;
  v_edits integer;
begin
  new.user_id    := old.user_id;
  new.created_at := old.created_at;
  if new.body is distinct from old.body then
    new.body := private.review_clean_body(new.body);
  end if;

  if new.rating is distinct from old.rating
     or new.program is distinct from old.program
     or new.body is distinct from old.body then
    -- 회원이 API 로 내용을 고치는 경우. (SQL Editor 처럼 로그인 정보가 없는 실행은 검사하지 않는다. 백업 복구용이다.)
    if v_uid is not null then
      if v_uid is distinct from old.user_id then
        raise exception '후기 내용은 작성자 본인만 고칠 수 있습니다.' using errcode = '42501';
      end if;
      -- 회원일 때 쓴 글이 있는 계정이 관리자가 된 경우: 내용을 고칠 수 없다(지우기는 된다).
      if private.is_admin() then
        raise exception '관리자 계정으로는 후기를 고칠 수 없습니다.' using errcode = 'RV003';
      end if;
      if exists (select 1 from private.review_ban b where b.user_id = old.user_id) then
        raise exception '후기 작성이 제한된 계정입니다. 이의가 있으면 카카오톡 채널로 알려 주세요.' using errcode = 'RV005';
      end if;
      insert into private.review_quota as q (user_id, day, n, edits)
      values (v_uid, v_day, 0, 1)
      on conflict (user_id) do update
        set edits = case when q.day = excluded.day then q.edits + 1 else 1 end,
            n     = case when q.day = excluded.day then q.n else 0 end,
            day   = excluded.day
      returning q.edits into v_edits;
      if v_edits > 20 then
        raise exception '후기는 하루에 20번까지 고칠 수 있습니다. 내일 다시 시도해 주세요.' using errcode = 'RV006';
      end if;
    end if;
    new.updated_at := now();
    -- 프로그램을 바꾸면 수강 확인은 다시 받는다(확인은 그 프로그램에 대한 것이다).
    if new.program is distinct from old.program then
      new.verified    := false;
      new.verified_at := null;
    end if;
  else
    new.updated_at := old.updated_at;
  end if;

  -- 표시 이름은 언제나 지금의 프로필 이름으로 서버가 만든다(이름이 비어 있으면 그대로 둔다).
  select p.name into v_name from public.profiles p where p.id = old.user_id;
  if v_name is not null then
    new.author_label := private.review_author_label(v_name);
  else
    new.author_label := old.author_label;
  end if;

  return new;
end;
$$;

revoke all on function private.reviews_before_update() from public;

drop trigger if exists reviews_before_update on public.reviews;
create trigger reviews_before_update
  before update on public.reviews
  for each row execute function private.reviews_before_update();

-- 삭제 뒤: 숨김 처리된 자기 글을 회원이 스스로 지우면 14일 동안 새 글을 보류한다.
-- 탈퇴로 함께 지워지는 경우(계정이 이미 없다)와 SQL Editor 에서 지우는 경우(로그인 정보가 없다)는 해당하지 않는다.
create or replace function private.reviews_after_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if old.hidden_at is not null and v_uid is not null and v_uid = old.user_id
     and exists (select 1 from auth.users u where u.id = old.user_id) then
    insert into private.review_hold as h (user_id, until)
    values (old.user_id, now() + interval '14 days')
    on conflict (user_id) do update set until = greatest(h.until, excluded.until);
  end if;
  return null;
end;
$$;

revoke all on function private.reviews_after_delete() from public;

drop trigger if exists reviews_after_delete on public.reviews;
create trigger reviews_after_delete
  after delete on public.reviews
  for each row execute function private.reviews_after_delete();

-- 표시 이름 맞추기: 회원이 프로필 이름을 바꾸면 그 회원의 모든 후기의 표시 이름을 함께 바꾼다.
-- (이름을 바꿔 가며 쓴 후기들이 서로 다른 사람의 후기처럼 보이지 않게 한다. 수정 시각은 바뀌지 않는다.)
create or replace function private.reviews_sync_author_label()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.name is not null then
    update public.reviews r
    set author_label = private.review_author_label(new.name)   -- 실제 값은 수정 트리거가 프로필에서 다시 만든다
    where r.user_id = new.id
      and r.author_label is distinct from private.review_author_label(new.name);
  end if;
  return null;
end;
$$;

revoke all on function private.reviews_sync_author_label() from public;

drop trigger if exists profiles_sync_review_label on public.profiles;
create trigger profiles_sync_review_label
  after update on public.profiles
  for each row
  when (old.name is distinct from new.name)
  execute function private.reviews_sync_author_label();

-- ── 4) 권한과 행 수준 보안(RLS) ───────────────────────────
-- 읽기: 숨기지 않은 후기는 누구나(로그인 없이도). 읽을 수 있는 칸에 user_id · 숨김 사유 · 메모는 없다.
-- 쓰기: 로그인한 회원이 본인 글만. 고칠 수 있는 칸은 별점 · 프로그램 · 본문뿐이다.
alter table public.reviews enable row level security;

revoke all on table public.reviews from anon, authenticated;
grant select (id, rating, program, body, author_label, verified, created_at, updated_at, hidden_at)
  on table public.reviews to anon, authenticated;
grant insert (rating, program, body) on table public.reviews to authenticated;
grant update (rating, program, body) on table public.reviews to authenticated;
grant delete on table public.reviews to authenticated;

drop policy if exists "게시된 후기 조회" on public.reviews;
create policy "게시된 후기 조회" on public.reviews
  for select to anon, authenticated
  using (hidden_at is null);

-- 숨김 처리된 본인 글도 고치고 지울 수 있게 본인 글은 항상 보인다(수정·삭제 대상 행을 찾는 데 필요하다).
drop policy if exists "본인 후기 조회" on public.reviews;
create policy "본인 후기 조회" on public.reviews
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "본인 후기 작성" on public.reviews;
create policy "본인 후기 작성" on public.reviews
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "본인 후기 수정" on public.reviews;
create policy "본인 후기 수정" on public.reviews
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "본인 후기 삭제" on public.reviews;
create policy "본인 후기 삭제" on public.reviews
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ── 5) 공개 조회용 뷰 ─────────────────────────────────────
-- 후기 페이지와 모니터링이 읽는 유일한 통로. 조회하는 사람의 권한으로 실행된다(security_invoker):
-- 위의 열 권한과 RLS 가 그대로 적용되고, 숨김 처리된 글은 작성자 본인에게도 여기에는 나오지 않는다.
drop view if exists public.reviews_public;
create view public.reviews_public
with (security_invoker = true)
as
  select r.id, r.rating, r.program, r.body, r.author_label as author, r.verified, r.created_at, r.updated_at
  from public.reviews r
  where r.hidden_at is null;

comment on view public.reviews_public is '게시 중인 회원 후기(공개). author 는 가린 이름이다. 실명·이메일·휴대전화 번호·user_id 는 없다.';

revoke all on table public.reviews_public from anon, authenticated;
grant select on table public.reviews_public to anon, authenticated;

-- ── 6) 숨김 처리 현황(공개) ───────────────────────────────
-- 지금 숨김 처리되어 있는 후기의 사유별 건수만 돌려준다. 후기 페이지의 「운영 기준」 안내에 적어
-- 숨김 조치가 있었다는 사실을 누구나 알 수 있게 한다. 글 번호·내용·작성자는 주지 않는다.
drop function if exists public.review_hidden_stats();
create function public.review_hidden_stats()
returns table (reason text, n integer)
language sql
stable
security definer
set search_path = ''
as $$
  select r.hidden_reason, count(*)::integer
  from public.reviews r
  where r.hidden_at is not null
  group by r.hidden_reason
  order by r.hidden_reason;
$$;

revoke all on function public.review_hidden_stats() from public;
grant execute on function public.review_hidden_stats() to anon, authenticated;

-- ── 7) 내가 쓴 후기 · 내가 후기를 쓸 수 있는 상태인지 ─────────
-- 숨김 처리된 글과 그 사유(종류), 관리자가 적은 구체 사유(메모), 숨긴 시각까지 본인에게 보여 준다.
drop function if exists public.my_reviews();
create function public.my_reviews()
returns table (
  id            bigint,
  rating        smallint,
  program       text,
  body          text,
  author        text,
  verified      boolean,
  created_at    timestamptz,
  updated_at    timestamptz,
  hidden        boolean,
  hidden_reason text,
  hidden_detail text,
  hidden_at     timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.rating, r.program, r.body, r.author_label, r.verified, r.created_at, r.updated_at,
         r.hidden_at is not null, r.hidden_reason, r.hidden_note, r.hidden_at
  from public.reviews r
  where r.user_id = auth.uid()
  order by r.id desc;
$$;

revoke all on function public.my_reviews() from public, anon;
grant execute on function public.my_reviews() to authenticated;

-- 후기 페이지가 쓰기 영역을 정하는 데 쓴다. 프로필(실명 등)을 화면으로 내려보내지 않고 상태와 표시 이름만 준다.
--   state: ok(쓸 수 있음) · onboarding(가입 마무리 전) · admin(관리자 계정) · banned(작성 제한)
--          · hold(숨김 처리된 글을 지운 뒤의 새 글 보류. 이미 쓴 글은 고칠 수 있다)
--   author: 지금 후기를 쓰면 붙는 표시 이름(예: 김**). ok·hold 일 때만
--   hold_until: 보류가 끝나는 시각. hold 일 때만
drop function if exists public.my_review_status();
create function public.my_review_status()
returns table (state text, author text, hold_until timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text;
  v_done  boolean;
  v_admin boolean;
  v_until timestamptz;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;
  select p.name, p.is_admin,
         (p.name is not null and p.member_type is not null and p.grade is not null
           and p.terms_agreed_at is not null and p.privacy_agreed_at is not null
           and p.age_confirmed_at is not null)
    into v_name, v_admin, v_done
  from public.profiles p
  where p.id = v_uid;
  select h.until into v_until from private.review_hold h where h.user_id = v_uid and h.until > now();

  if not coalesce(v_done, false) then
    return query select 'onboarding'::text, null::text, null::timestamptz;
  elsif coalesce(v_admin, false) then
    return query select 'admin'::text, null::text, null::timestamptz;
  elsif exists (select 1 from private.review_ban b where b.user_id = v_uid) then
    return query select 'banned'::text, null::text, null::timestamptz;
  elsif v_until is not null then
    return query select 'hold'::text, private.review_author_label(v_name), v_until;
  else
    return query select 'ok'::text, private.review_author_label(v_name), null::timestamptz;
  end if;
end;
$$;

revoke all on function public.my_review_status() from public, anon;
grant execute on function public.my_review_status() to authenticated;

-- ── 8) 관리자 함수 ────────────────────────────────────────
-- 목록: 숨긴 글까지 전부. 수강 기록과 대조하기 위해 회원 이름·이메일·회원 구분을 함께 준다(휴대전화 번호는 주지 않는다).
--   notified_at: 지금의 숨김에 대해 작성자에게 알렸다고 적은 마지막 시각(없으면 null)
drop function if exists public.admin_list_reviews();
create function public.admin_list_reviews()
returns table (
  id            bigint,
  created_at    timestamptz,
  updated_at    timestamptz,
  rating        smallint,
  program       text,
  body          text,
  author_label  text,
  verified      boolean,
  verified_at   timestamptz,
  hidden_at     timestamptz,
  hidden_reason text,
  hidden_note   text,
  name          text,
  email         text,
  member_type   text,
  banned        boolean,
  notified_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception '관리자만 볼 수 있습니다.' using errcode = '42501';
  end if;
  return query
    select r.id, r.created_at, r.updated_at, r.rating, r.program, r.body, r.author_label,
           r.verified, r.verified_at, r.hidden_at, r.hidden_reason, r.hidden_note,
           p.name, u.email::text, p.member_type,
           exists (select 1 from private.review_ban b where b.user_id = r.user_id),
           (select max(l.at) from private.review_moderation_log l
             where l.review_id = r.id and l.action = 'notify' and r.hidden_at is not null and l.at >= r.hidden_at)
    from public.reviews r
    join auth.users u on u.id = r.user_id
    left join public.profiles p on p.id = r.user_id
    order by r.id desc;
end;
$$;

revoke all on function public.admin_list_reviews() from public, anon;
grant execute on function public.admin_list_reviews() to authenticated;

-- 숨김·숨김 해제: 숨길 때는 사유가 필수이고, 「법령 위반」과 「임시 조치(권리 침해 신고)」는 메모(2자 이상)도 필수다.
-- 이미 숨긴 글에 다시 부르면 사유·메모만 바뀌고 처음 숨긴 시각은 그대로다. 처리할 때마다 기록을 한 줄 남긴다.
-- 해제할 때의 p_note 는 해제한 까닭(예: 작성자가 개인정보를 지움)으로 기록에만 남는다.
-- 관리자가 자기 계정으로 쓴 글(관리자가 되기 전에 쓴 글)은 스스로 처리할 수 없다.
create or replace function public.admin_set_review_hidden(
  p_id     bigint,
  p_hidden boolean,
  p_reason text default null,
  p_note   text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note text := nullif(btrim(left(btrim(coalesce(p_note, '')), 300)), '');
  v_old  record;
begin
  if not private.is_admin() then
    raise exception '관리자만 할 수 있습니다.' using errcode = '42501';
  end if;

  select r.user_id, r.rating, r.program, r.hidden_at, r.hidden_reason, r.hidden_note
    into v_old
  from public.reviews r
  where r.id = p_id
  for update;
  if not found then
    raise exception '후기를 찾을 수 없습니다. 작성자가 지웠을 수 있습니다.' using errcode = 'RV004';
  end if;
  if v_old.user_id = auth.uid() then
    raise exception '본인 계정으로 쓴 후기는 직접 처리할 수 없습니다.' using errcode = 'RV008';
  end if;

  if coalesce(p_hidden, false) then
    if p_reason is null or p_reason not in ('욕설·인신공격', '광고·스팸', '개인정보 노출', '허위 사실·권리 침해', '법령 위반', '임시 조치(권리 침해 신고)') then
      raise exception '숨김 사유를 골라 주세요.' using errcode = '23514';
    end if;
    if p_reason in ('법령 위반', '임시 조치(권리 침해 신고)') and char_length(coalesce(v_note, '')) < 2 then
      raise exception '이 사유는 메모에 구체 사유를 적어 주세요.' using errcode = '23514';
    end if;
    if v_old.hidden_at is not null and v_old.hidden_reason = p_reason and v_old.hidden_note is not distinct from v_note then
      return;  -- 바뀐 것이 없다
    end if;
    update public.reviews r
    set hidden_at = coalesce(r.hidden_at, now()), hidden_reason = p_reason, hidden_note = v_note
    where r.id = p_id;
    insert into private.review_moderation_log (review_id, action, rating, program, reason, note, admin_id)
    values (p_id, case when v_old.hidden_at is null then 'hide' else 'reason' end,
            v_old.rating, v_old.program, p_reason, v_note, auth.uid());
  else
    if v_old.hidden_at is null then
      return;  -- 이미 게시 중이다
    end if;
    update public.reviews r
    set hidden_at = null, hidden_reason = null, hidden_note = null
    where r.id = p_id;
    insert into private.review_moderation_log (review_id, action, rating, program, reason, note, admin_id)
    values (p_id, 'unhide', v_old.rating, v_old.program, v_old.hidden_reason, v_note, auth.uid());
  end if;
end;
$$;

revoke all on function public.admin_set_review_hidden(bigint, boolean, text, text) from public, anon;
grant execute on function public.admin_set_review_hidden(bigint, boolean, text, text) to authenticated;

-- 수강 확인 표시·취소. 학습코칭·생기부 컨설팅 후기에만 붙일 수 있다. 자기 계정으로 쓴 글에는 붙일 수 없다.
create or replace function public.admin_set_review_verified(p_id bigint, p_verified boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old record;
  v_on  boolean := coalesce(p_verified, false);
begin
  if not private.is_admin() then
    raise exception '관리자만 할 수 있습니다.' using errcode = '42501';
  end if;

  select r.user_id, r.rating, r.program, r.verified
    into v_old
  from public.reviews r
  where r.id = p_id
  for update;
  if not found then
    raise exception '후기를 찾을 수 없습니다. 작성자가 지웠을 수 있습니다.' using errcode = 'RV004';
  end if;
  if v_old.user_id = auth.uid() then
    raise exception '본인 계정으로 쓴 후기는 직접 처리할 수 없습니다.' using errcode = 'RV008';
  end if;
  if v_on and v_old.program not in ('학습코칭', '생기부 컨설팅') then
    raise exception '수강 확인은 학습코칭·생기부 컨설팅 후기에만 붙일 수 있습니다.' using errcode = '23514';
  end if;
  if v_old.verified = v_on then
    return;  -- 바뀐 것이 없다
  end if;

  update public.reviews r
  set verified    = v_on,
      verified_at = case when v_on then now() end
  where r.id = p_id;
  insert into private.review_moderation_log (review_id, action, rating, program, admin_id)
  values (p_id, case when v_on then 'verify' else 'unverify' end, v_old.rating, v_old.program, auth.uid());
end;
$$;

revoke all on function public.admin_set_review_verified(bigint, boolean) from public, anon;
grant execute on function public.admin_set_review_verified(bigint, boolean) to authenticated;

-- 작성자에게 알렸다는 기록. 안내 메일은 관리자가 메일 앱에서 직접 보내므로, 보낸 뒤 이 함수로 「알렸다」는 사실을 남긴다
-- (약관 제10조 제7항의 통지를 했다는 것을 나중에 보일 수 있게). 받는 사람·메일 내용은 남기지 않는다.
--   p_kind: 숨김 안내 · 해제 결과 안내 · 이의 검토 결과 안내
create or replace function public.admin_log_review_notice(p_id bigint, p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old record;
begin
  if not private.is_admin() then
    raise exception '관리자만 할 수 있습니다.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('숨김 안내', '해제 결과 안내', '이의 검토 결과 안내') then
    raise exception '어떤 안내를 보냈는지 골라 주세요.' using errcode = '23514';
  end if;
  select r.rating, r.program, r.hidden_reason
    into v_old
  from public.reviews r
  where r.id = p_id;
  if not found then
    raise exception '후기를 찾을 수 없습니다. 작성자가 지웠을 수 있습니다.' using errcode = 'RV004';
  end if;
  insert into private.review_moderation_log (review_id, action, rating, program, reason, note, admin_id)
  values (p_id, 'notify', v_old.rating, v_old.program, v_old.hidden_reason, p_kind, auth.uid());
end;
$$;

revoke all on function public.admin_log_review_notice(bigint, text) from public, anon;
grant execute on function public.admin_log_review_notice(bigint, text) to authenticated;

-- 처리 기록 목록(관리자 화면의 「처리 기록 CSV」). 작성자·본문은 없다.
drop function if exists public.admin_list_review_log();
create function public.admin_list_review_log()
returns table (
  at          timestamptz,
  review_id   bigint,
  action      text,
  rating      smallint,
  program     text,
  reason      text,
  note        text,
  admin_email text,
  deleted     boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception '관리자만 볼 수 있습니다.' using errcode = '42501';
  end if;
  return query
    select l.at, l.review_id, l.action, l.rating, l.program, l.reason, l.note, u.email::text,
           not exists (select 1 from public.reviews r where r.id = l.review_id)
    from private.review_moderation_log l
    left join auth.users u on u.id = l.admin_id
    order by l.id desc;
end;
$$;

revoke all on function public.admin_list_review_log() from public, anon;
grant execute on function public.admin_list_review_log() to authenticated;

-- ── 9) 정리 작업 ──────────────────────────────────────────
-- ① 지난 날의 작성 횟수 기록, 끝난 보류, 처리한 지 3년이 지난 처리 기록을 지운다.
-- ② 「임시 조치(권리 침해 신고)」로 숨긴 지 29일이 지난 후기를 다시 게시하고 기록을 남긴다.
--    약관 제10조 제8항: 임시로 숨기는 기간은 30일 이내이고, 그 안에 정하지 못하면 다시 게시한다.
--    하루에 한 번 도는 작업이라 29일을 기준으로 해야 30일을 넘기지 않는다. 그 전에 판단했으면
--    관리자 화면에서 사유를 고치거나(계속 숨김) 숨김을 해제해 둔다.
create or replace function private.purge_review_records()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.review_quota where day < (now() at time zone 'Asia/Seoul')::date;
  delete from private.review_hold where until < now();
  delete from private.review_moderation_log where at < now() - interval '3 years';
  with back as (
    select r.id, r.rating, r.program, r.hidden_reason
    from public.reviews r
    where r.hidden_reason = '임시 조치(권리 침해 신고)' and r.hidden_at < now() - interval '29 days'
    for update
  ), done as (
    update public.reviews r
    set hidden_at = null, hidden_reason = null, hidden_note = null
    from back
    where r.id = back.id
    returning back.id, back.rating, back.program, back.hidden_reason
  )
  insert into private.review_moderation_log (review_id, action, rating, program, reason, note, admin_id)
  select d.id, 'unhide', d.rating, d.program, d.hidden_reason, '임시 조치 기간이 끝나 자동으로 다시 게시', null
  from done d;
$$;

revoke all on function private.purge_review_records() from public;

-- 매일 03:37(UTC, 한국 시각 12:37). 같은 이름으로 다시 실행하면 일정만 갱신된다.
-- pg_cron 은 20261001000000_members.sql 이 켠다. 없으면 건너뛴다(작성 횟수 기록은 회원당 한 줄이고 다음에 쓸 때 새로 쓴다).
do $cron$
begin
  if to_regnamespace('cron') is not null then
    perform cron.schedule('snucoach-purge-review-records', '37 3 * * *', 'select private.purge_review_records()');
  else
    raise notice 'pg_cron 이 없어 정리 작업을 만들지 않았습니다.';
  end if;
end $cron$;

commit;

-- API(PostgREST)가 새 표·뷰·함수를 바로 알도록 한다.
notify pgrst, 'reload schema';
