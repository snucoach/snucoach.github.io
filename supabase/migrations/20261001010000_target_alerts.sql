-- ============================================================
-- 스누코치 — 목표 대학 입시 정보 알림
--
-- 사용법: 20261001000000_members.sql 을 먼저 실행한 뒤, 이 파일 전체를
--         SQL Editor 에 붙여 넣고 Run. 여러 번 실행해도 같은 결과가 된다.
--
-- 대학 라인 잡기(정시)에서 학생이 고른 목표 대학 중 '인서울 주요 대학'만
-- 알림 대상으로 저장한다. 회원 본인만 보고·추가·삭제할 수 있고, 관리자는
-- admin_list_target_alerts() 로 전체 신청 목록을 본다(알림 발송용).
-- 탈퇴하면 함께 삭제된다.
-- ============================================================

create table if not exists public.target_alerts (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  univ        text not null check (univ in (
                '서울대', '연세대', '고려대', '서강대', '성균관대', '한양대',
                '중앙대', '경희대', '한국외국어대', '서울시립대', '이화여대',
                '건국대', '동국대', '홍익대', '국민대', '숭실대', '세종대', '광운대')),
  track       text check (track is null or char_length(track) between 1 and 40),  -- 계열(예: 자연, 인문·사회)
  created_at  timestamptz not null default now(),
  unique (user_id, univ)
);

comment on table public.target_alerts is '목표 대학 입시 정보 알림 신청. 인서울 주요 18개 대학만 받는다.';

-- 한 사람당 최대 18곳(대상 대학 수)
create or replace function private.target_alerts_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.target_alerts where user_id = new.user_id) >= 18 then
    raise exception '알림은 최대 18곳까지 신청할 수 있습니다.' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.target_alerts_limit() from public;

drop trigger if exists target_alerts_limit on public.target_alerts;
create trigger target_alerts_limit
  before insert on public.target_alerts
  for each row execute function private.target_alerts_limit();

alter table public.target_alerts enable row level security;

revoke all on table public.target_alerts from anon, authenticated;
grant select, delete on table public.target_alerts to authenticated;
grant insert (univ, track) on table public.target_alerts to authenticated;

drop policy if exists "본인 알림 조회" on public.target_alerts;
create policy "본인 알림 조회" on public.target_alerts
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "본인 알림 추가" on public.target_alerts;
create policy "본인 알림 추가" on public.target_alerts
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "본인 알림 수정" on public.target_alerts;

drop policy if exists "본인 알림 삭제" on public.target_alerts;
create policy "본인 알림 삭제" on public.target_alerts
  for delete to authenticated using ((select auth.uid()) = user_id);

-- 관리자 전용: 알림 신청 전체(발송 대상 확인용)
create or replace function public.admin_list_target_alerts()
returns table (
  univ        text,
  track       text,
  email       text,
  name        text,
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
    select a.univ, a.track, u.email::text, p.name, p.member_type, p.grade, a.created_at
    from public.target_alerts a
    join auth.users u on u.id = a.user_id
    left join public.profiles p on p.id = a.user_id
    order by a.univ, a.created_at;
end;
$$;

revoke all on function public.admin_list_target_alerts() from public, anon;
grant execute on function public.admin_list_target_alerts() to authenticated;
