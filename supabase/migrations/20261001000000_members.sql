-- ============================================================
-- 스누코치 회원 기능 — 데이터베이스 설정
--
-- 사용법: Supabase 대시보드 > SQL Editor > New query 에 이 파일 전체를
--         붙여 넣고 Run. 여러 번 실행해도 같은 결과가 되도록 작성했다.
--
-- 만드는 것
--   1) public.profiles        회원 프로필(이름·회원 구분·학년·동의 기록)
--   2) 가입 트리거            auth.users 에 회원이 생기면 프로필을 자동 생성
--   3) 수정 트리거            동의 시각은 서버 시각으로만, 한 번 기록되면 고정
--   4) 행 수준 보안(RLS)      본인 프로필만 조회·수정
--   5) delete_my_account()    회원 탈퇴(계정과 프로필 즉시 삭제)
--   6) admin_list_members()   관리자 전용 회원 목록
--   7) ping()                 무료 플랜 일시정지 방지용 가벼운 호출
--   8) 매일 정리 작업          3개월 지난 로그인 기록·세션 삭제(pg_cron)
--
-- 비밀번호는 Supabase Auth(auth.users)가 bcrypt 해시로만 저장한다.
-- 이 파일의 어떤 테이블에도 비밀번호를 저장하지 않는다.
-- ============================================================

-- API(PostgREST)로 노출되지 않는 내부 함수용 스키마
create schema if not exists private;
revoke all on schema private from public;

-- ── 1) 프로필 테이블 ──────────────────────────────────────
create table if not exists public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  name                text check (name is null or char_length(name) between 1 and 20),
  member_type         text check (member_type is null or member_type in ('학생', '학부모', '기타')),
  grade               text check (grade is null or grade in ('초등', '중1', '중2', '중3', '고1', '고2', '고3', 'N수', '기타')),
  marketing_opt_in    boolean not null default false,
  marketing_opt_in_at timestamptz,          -- 마케팅 수신 동의·철회를 마지막으로 바꾼 시각
  terms_agreed_at     timestamptz,          -- [필수] 이용약관 동의 시각
  privacy_agreed_at   timestamptz,          -- [필수] 개인정보 수집·이용 동의 시각
  age_confirmed_at    timestamptz,          -- [필수] 만 14세 이상 확인 시각
  is_admin            boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.profiles is '스누코치 회원 프로필. 계정(이메일·비밀번호)은 auth.users 에 있고, 탈퇴하면 이 행도 함께 삭제된다.';
comment on column public.profiles.is_admin is '관리자 여부. 사용자는 바꿀 수 없고 SQL Editor 에서만 바꾼다.';

-- ── 2) 가입 트리거: 회원이 생기면 프로필 생성 ──────────────
-- 이메일 가입은 signUp(options.data)으로 넘긴 값을, 카카오 가입은 닉네임을 쓴다.
-- 값이 형식에 맞지 않으면 버리고(null) 가입은 막지 않는다.
-- 필수 동의가 빠진 회원은 마이페이지에서 '가입 마무리' 화면을 먼저 보게 된다.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta        jsonb   := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_name      text    := nullif(left(btrim(coalesce(meta ->> 'name', '')), 20), '');
  v_type      text    := meta ->> 'member_type';
  v_grade     text    := meta ->> 'grade';
  v_agreed    boolean := coalesce(meta ->> 'agree_terms', '') = 'true'
                     and coalesce(meta ->> 'agree_privacy', '') = 'true'
                     and coalesce(meta ->> 'agree_age', '') = 'true';
  v_marketing boolean := coalesce(meta ->> 'marketing', '') = 'true';
begin
  if v_type is not null and v_type not in ('학생', '학부모', '기타') then
    v_type := null;
  end if;
  if v_grade is not null and v_grade not in ('초등', '중1', '중2', '중3', '고1', '고2', '고3', 'N수', '기타') then
    v_grade := null;
  end if;

  insert into public.profiles (
    id, name, member_type, grade,
    marketing_opt_in, marketing_opt_in_at,
    terms_agreed_at, privacy_agreed_at, age_confirmed_at
  ) values (
    new.id, v_name, v_type, v_grade,
    v_agreed and v_marketing, case when v_agreed and v_marketing then now() end,
    case when v_agreed then now() end,
    case when v_agreed then now() end,
    case when v_agreed then now() end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function private.handle_new_user() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- 이 파일보다 먼저 만들어진 계정에도 빈 프로필을 만들어 둔다(마이페이지에서 가입 마무리).
insert into public.profiles (id)
select u.id from auth.users u
on conflict (id) do nothing;

-- ── 3) 수정 트리거: 기록 시각은 서버가 정한다 ─────────────
create or replace function private.profiles_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.id         := old.id;
  new.created_at := old.created_at;
  new.updated_at := now();

  -- 필수 동의: 처음 기록할 때만 서버 시각으로 남기고, 이후에는 바뀌지 않는다.
  new.terms_agreed_at   := coalesce(old.terms_agreed_at,   case when new.terms_agreed_at   is not null then now() end);
  new.privacy_agreed_at := coalesce(old.privacy_agreed_at, case when new.privacy_agreed_at is not null then now() end);
  new.age_confirmed_at  := coalesce(old.age_confirmed_at,  case when new.age_confirmed_at  is not null then now() end);

  -- 마케팅 수신: 동의·철회가 바뀐 때만 시각을 새로 남긴다.
  if new.marketing_opt_in is distinct from old.marketing_opt_in then
    new.marketing_opt_in_at := now();
  else
    new.marketing_opt_in_at := old.marketing_opt_in_at;
  end if;

  return new;
end;
$$;

revoke all on function private.profiles_before_update() from public;

drop trigger if exists profiles_before_update on public.profiles;
create trigger profiles_before_update
  before update on public.profiles
  for each row execute function private.profiles_before_update();

-- ── 4) 권한과 행 수준 보안(RLS) ───────────────────────────
-- 로그인하지 않은 방문자(anon)는 아무것도 못 하고,
-- 로그인한 회원(authenticated)은 본인 행만 보고, 정해진 칸만 고칠 수 있다.
alter table public.profiles enable row level security;

revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (name, member_type, grade, marketing_opt_in,
              terms_agreed_at, privacy_agreed_at, age_confirmed_at)
  on table public.profiles to authenticated;

drop policy if exists "본인 프로필 조회" on public.profiles;
create policy "본인 프로필 조회" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "본인 프로필 수정" on public.profiles;
create policy "본인 프로필 수정" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- ── 5) 회원 탈퇴 ──────────────────────────────────────────
-- 계정(auth.users)을 지우면 프로필·로그인 세션도 함께 삭제된다(on delete cascade).
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ── 6) 관리자 전용 회원 목록 ──────────────────────────────
create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

revoke all on function private.is_admin() from public;

create or replace function public.admin_list_members()
returns table (
  id                  uuid,
  email               text,
  provider            text,
  email_confirmed     boolean,
  name                text,
  member_type         text,
  grade               text,
  marketing_opt_in    boolean,
  marketing_opt_in_at timestamptz,
  profile_completed   boolean,
  created_at          timestamptz,
  last_sign_in_at     timestamptz
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
    select
      u.id,
      u.email::text,
      coalesce(u.raw_app_meta_data ->> 'provider', 'email'),
      u.email_confirmed_at is not null,
      p.name,
      p.member_type,
      p.grade,
      coalesce(p.marketing_opt_in, false),
      p.marketing_opt_in_at,
      (p.name is not null and p.member_type is not null and p.grade is not null
        and p.terms_agreed_at is not null and p.privacy_agreed_at is not null
        and p.age_confirmed_at is not null),
      u.created_at,
      u.last_sign_in_at
    from auth.users u
    left join public.profiles p on p.id = u.id
    order by u.created_at desc;
end;
$$;

revoke all on function public.admin_list_members() from public, anon;
grant execute on function public.admin_list_members() to authenticated;

-- ── 7) 일시정지 방지용 호출 ───────────────────────────────
-- 무료 플랜은 일주일간 DB 활동이 거의 없으면 일시정지된다.
-- .github/workflows/supabase-keepalive.yml 이 하루 한 번 호출한다. 데이터는 읽지 않는다.
create or replace function public.ping()
returns text
language sql
stable
set search_path = ''
as $$
  select 'ok'::text;
$$;

revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;

-- ── 8) 로그인 기록 보관 기간(3개월) ──────────────────────
-- 인증 서버가 남기는 로그인 기록(IP 주소 등)과 3개월 넘게 쓰지 않은 로그인 세션을 매일 지운다.
-- 개인정보처리방침의 '로그인 기록은 3개월 보관 후 삭제'와 짝을 이룬다.
create extension if not exists pg_cron;

create or replace function private.purge_auth_logs()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.audit_log_entries where created_at < now() - interval '90 days';
  delete from auth.sessions where coalesce(refreshed_at, updated_at, created_at) < now() - interval '90 days';
$$;

revoke all on function private.purge_auth_logs() from public;

-- 매일 03:17(UTC, 한국 시각 12:17). 같은 이름으로 다시 실행하면 일정만 갱신된다.
select cron.schedule('snucoach-purge-auth-logs', '17 3 * * *', 'select private.purge_auth_logs()');

-- ============================================================
-- 관리자 지정 (가입을 마친 뒤, 이메일을 바꿔서 따로 실행)
--
--   update public.profiles set is_admin = true
--   where id = (select id from auth.users where email = '관리자@이메일.com');
-- ============================================================
