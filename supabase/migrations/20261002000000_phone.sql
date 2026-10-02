-- ============================================================
-- 스누코치 — 휴대전화 번호 수집 + 광고성 정보 문자 수신 동의
--
-- 사용법: 20261001000000_members.sql, 20261001010000_target_alerts.sql 을 먼저 실행한 뒤,
--         이 파일 전체를 SQL Editor 에 붙여 넣고 Run. 여러 번 실행해도 같은 결과가 된다.
--         사이트 배포보다 먼저 실행한다(옛 사이트는 추가된 열을 모르는 채로 그대로 동작한다).
--
-- 바꾸는 것
--   1) profiles 에 phone · phone_agreed_at · marketing_sms_opt_in · marketing_sms_opt_in_at 추가
--      (기존 회원: phone 은 비어 있고 문자 수신은 미동의. 이메일 수신 동의는 문자 동의로 보지 않는다)
--   2) 가입 트리거: 가입 정보의 phone · marketing_sms 를 프로필에 기록하고, 가입 정보에서는 지운다
--   3) 수정 트리거: 번호는 숫자만 남기고, 동의 시각은 서버 시각으로만 기록
--   4) 회원이 고칠 수 있는 칸에 phone · marketing_sms_opt_in 추가
--   5) 이 파일을 처음 실행할 때만: 사이트가 먼저 배포된 사이에 가입한 회원의 번호를 프로필로 옮긴다
--   6) 관리자 목록 두 개에 휴대전화 번호(회원 목록에는 문자 수신 동의도) 추가
-- ============================================================
begin;

-- ── 0) 처음 실행인지 표시 ─────────────────────────────────
-- 5)의 번호 옮기기는 phone 열을 처음 만드는 실행에서만 한다.
-- 다시 실행할 때도 옮기면, 삭제 요청으로 지운 번호가 가입 정보에서 되살아날 수 있다.
do $mark$
begin
  perform set_config('snucoach.phone_first_run',
    case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'profiles' and column_name = 'phone')
         then '0' else '1' end, true);
end $mark$;

-- ── 1) 열과 형식 검사 ─────────────────────────────────────
alter table public.profiles add column if not exists phone text;                                          -- 숫자만(예: 01012345678)
alter table public.profiles add column if not exists phone_agreed_at timestamptz;                         -- 휴대전화 번호 수집·이용 동의(처음 입력한) 시각
alter table public.profiles add column if not exists marketing_sms_opt_in boolean not null default false; -- [선택] 광고성 정보 문자 수신 동의
alter table public.profiles add column if not exists marketing_sms_opt_in_at timestamptz;                 -- 문자 수신 동의·철회를 마지막으로 바꾼 시각

alter table public.profiles drop constraint if exists profiles_phone_format;
alter table public.profiles add constraint profiles_phone_format
  check (phone is null or phone ~ '^(010[0-9]{8}|01[16789][0-9]{7,8})$');

alter table public.profiles drop constraint if exists profiles_sms_needs_phone;
alter table public.profiles add constraint profiles_sms_needs_phone
  check (not marketing_sms_opt_in or phone is not null);

comment on column public.profiles.phone is '휴대전화 번호(숫자만). 인증 문자는 보내지 않는다. auth.users.phone(전화 로그인용)은 쓰지 않는다.';
comment on column public.profiles.marketing_opt_in is '광고성 정보 이메일 수신 동의. 문자 수신은 marketing_sms_opt_in 에 따로 기록한다.';
comment on column public.profiles.marketing_sms_opt_in is '광고성 정보 문자 수신 동의. 이메일 수신 동의와 별개이며 번호가 없으면 항상 false.';

-- ── 2) 가입 트리거 ────────────────────────────────────────
-- phone: 숫자만 남기고(+82 10… 은 010… 으로) 형식이 맞고 필수 동의가 있을 때만 저장한다.
-- marketing_sms: 새 가입 화면(이메일·문자 동의 문구)만 보낸다. 옛 화면의 marketing(이메일)만으로는 문자 동의가 되지 않는다.
-- 프로필에 옮긴 뒤 가입 정보(auth.users.raw_user_meta_data)의 phone · marketing_sms 는 지운다.
--   번호의 기준은 profiles.phone 하나로 두고, 로그인 토큰(user_metadata)에 번호가 실리지 않게 한다.
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
  v_phone     text;
  v_agreed    boolean := coalesce(meta ->> 'agree_terms', '') = 'true'
                     and coalesce(meta ->> 'agree_privacy', '') = 'true'
                     and coalesce(meta ->> 'agree_age', '') = 'true';
  v_marketing boolean := coalesce(meta ->> 'marketing', '') = 'true';
  v_sms       boolean := coalesce(meta ->> 'marketing_sms', '') = 'true';
begin
  if v_type is not null and v_type not in ('학생', '학부모', '기타') then
    v_type := null;
  end if;
  if v_grade is not null and v_grade not in ('초등', '중1', '중2', '중3', '고1', '고2', '고3', 'N수', '기타') then
    v_grade := null;
  end if;

  -- 번호 정리에 실패해도 가입은 막지 않는다(번호만 비운다 → 마이페이지에서 다시 입력).
  begin
    v_phone := regexp_replace(regexp_replace(coalesce(meta ->> 'phone', ''), '[^0-9]', '', 'g'), '^820?(1[016789])', '0\1');
    if not v_agreed or v_phone !~ '^(010[0-9]{8}|01[16789][0-9]{7,8})$' then
      v_phone := null;
    end if;
  exception when others then
    v_phone := null;
  end;
  v_sms := v_agreed and v_sms and v_phone is not null;

  insert into public.profiles (
    id, name, member_type, grade,
    phone, phone_agreed_at,
    marketing_opt_in, marketing_opt_in_at,
    marketing_sms_opt_in, marketing_sms_opt_in_at,
    terms_agreed_at, privacy_agreed_at, age_confirmed_at
  ) values (
    new.id, v_name, v_type, v_grade,
    v_phone, case when v_phone is not null then now() end,
    v_agreed and v_marketing, case when v_agreed and v_marketing then now() end,
    v_sms, case when v_sms then now() end,
    case when v_agreed then now() end,
    case when v_agreed then now() end,
    case when v_agreed then now() end
  )
  on conflict (id) do nothing;

  -- 가입 정보에 번호 사본을 남기지 않는다. 지우지 못해도 가입은 진행한다.
  if jsonb_typeof(meta) = 'object' and (meta ? 'phone' or meta ? 'marketing_sms') then
    begin
      update auth.users
      set raw_user_meta_data = raw_user_meta_data - 'phone' - 'marketing_sms'
      where id = new.id;
    exception when others then
      null;
    end;
  end if;

  return new;
end;
$$;

revoke all on function private.handle_new_user() from public;

-- ── 3) 수정 트리거 ────────────────────────────────────────
-- 회원 권한으로 실행되는 함수라 private 스키마의 다른 함수를 부를 수 없다. 정규식은 여기에 직접 쓴다.
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

  -- 광고성 정보 이메일 수신: 동의·철회가 바뀐 때만 시각을 새로 남긴다.
  if new.marketing_opt_in is distinct from old.marketing_opt_in then
    new.marketing_opt_in_at := now();
  else
    new.marketing_opt_in_at := old.marketing_opt_in_at;
  end if;

  -- 휴대전화 번호: 숫자만 남긴다(+82 10… 은 010… 으로). 형식은 CHECK(profiles_phone_format)가 검사한다.
  -- null 을 보내면 번호를 지운다. 빈 문자열이나 숫자가 없는 값은 지우기가 아니라 형식 오류(23514)로 거절된다.
  if new.phone is not null then
    new.phone := regexp_replace(regexp_replace(new.phone, '[^0-9]', '', 'g'), '^820?(1[016789])', '0\1');
  end if;
  -- 수집·이용 동의 시각: 번호를 처음 넣은 때의 서버 시각. 번호를 지우면 함께 지운다.
  new.phone_agreed_at := case when new.phone is null then null else coalesce(old.phone_agreed_at, now()) end;

  -- 광고성 정보 문자 수신: 번호가 없으면 동의로 기록하지 않는다. 바뀐 때만 시각을 새로 남긴다.
  new.marketing_sms_opt_in := coalesce(new.marketing_sms_opt_in, false) and new.phone is not null;
  if new.marketing_sms_opt_in is distinct from old.marketing_sms_opt_in then
    new.marketing_sms_opt_in_at := now();
  else
    new.marketing_sms_opt_in_at := old.marketing_sms_opt_in_at;
  end if;

  return new;
end;
$$;

revoke all on function private.profiles_before_update() from public;

-- ── 4) 회원이 고칠 수 있는 칸 ─────────────────────────────
-- (phone_agreed_at · marketing_sms_opt_in_at 은 서버만 기록한다)
grant update (phone, marketing_sms_opt_in) on table public.profiles to authenticated;

-- ── 5) 사이트가 먼저 배포된 사이에 가입한 회원 구제 + 가입 정보의 번호 사본 정리 ──
do $move$
begin
  -- (처음 실행할 때만) 가입 정보에만 남아 있는 번호를 프로필로 옮긴다.
  -- 문자 수신 동의는 옮기지 않는다(마이페이지에서 다시 켠다). 동의 시각(phone_agreed_at)은 이 파일을 실행한 시각으로 남는다.
  if current_setting('snucoach.phone_first_run', true) = '1' then
    update public.profiles p
    set phone = d.ph
    from (
      select u.id,
             regexp_replace(regexp_replace(coalesce(u.raw_user_meta_data ->> 'phone', ''), '[^0-9]', '', 'g'), '^820?(1[016789])', '0\1') as ph
      from auth.users u
      where jsonb_typeof(u.raw_user_meta_data) = 'object'
    ) d
    where d.id = p.id
      and p.phone is null
      and p.privacy_agreed_at is not null
      and d.ph ~ '^(010[0-9]{8}|01[16789][0-9]{7,8})$';
  end if;

  -- (실행할 때마다) 가입 정보에 남은 phone · marketing_sms 사본을 지운다. 번호의 기준은 profiles.phone 하나다.
  begin
    update auth.users
    set raw_user_meta_data = raw_user_meta_data - 'phone' - 'marketing_sms'
    where jsonb_typeof(raw_user_meta_data) = 'object'
      and (raw_user_meta_data ? 'phone' or raw_user_meta_data ? 'marketing_sms');
  exception when insufficient_privilege then
    raise notice '가입 정보(auth.users)의 phone 사본을 지우지 못했습니다(권한). README 의 삭제 절차를 따라 주세요.';
  end;
end $move$;

-- ── 6) 관리자 목록 ────────────────────────────────────────
-- 돌려주는 열이 바뀌므로 create or replace 로는 바꿀 수 없다(42P13). 지우고 다시 만든 뒤 권한을 다시 준다.
drop function if exists public.admin_list_members();
create function public.admin_list_members()
returns table (
  id                      uuid,
  email                   text,
  provider                text,
  email_confirmed         boolean,
  name                    text,
  phone                   text,
  member_type             text,
  grade                   text,
  marketing_opt_in        boolean,
  marketing_opt_in_at     timestamptz,
  marketing_sms_opt_in    boolean,
  marketing_sms_opt_in_at timestamptz,
  profile_completed       boolean,
  created_at              timestamptz,
  last_sign_in_at         timestamptz
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
      p.phone,
      p.member_type,
      p.grade,
      coalesce(p.marketing_opt_in, false),
      p.marketing_opt_in_at,
      coalesce(p.marketing_sms_opt_in, false),
      p.marketing_sms_opt_in_at,
      -- 가입 마무리(이름·구분·학년·필수 동의) 여부. 전화번호는 넣지 않는다:
      -- 넣으면 이 파일을 실행하는 순간 기존 회원이 모두 '가입 마무리 전'으로 집계된다. 미입력은 phone 이 null 인지로 본다.
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

drop function if exists public.admin_list_target_alerts();
create function public.admin_list_target_alerts()
returns table (
  univ        text,
  track       text,
  email       text,
  name        text,
  phone       text,
  member_type text,
  grade       text,
  created_at  timestamptz
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
    select a.univ, a.track, u.email::text, p.name, p.phone, p.member_type, p.grade, a.created_at
    from public.target_alerts a
    join auth.users u on u.id = a.user_id
    left join public.profiles p on p.id = a.user_id
    order by a.univ, a.created_at;
end;
$$;

revoke all on function public.admin_list_target_alerts() from public, anon;
grant execute on function public.admin_list_target_alerts() to authenticated;

commit;

-- API(PostgREST)가 바뀐 열·함수를 바로 알도록 한다.
notify pgrst, 'reload schema';
