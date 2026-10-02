-- ============================================================
-- 스누코치 — 알림 신청은 가입 마무리(필수 동의)와 휴대전화 번호가 있는 회원만
--
-- 사용법: 20261002000000_phone.sql 을 실행하고 새 사이트를 배포한 뒤, 하루쯤 지나서
--         (옛 화면이 브라우저에 남아 있지 않을 때) 실행한다.
--         사이트보다 먼저 실행하면 옛 화면에서 전화번호 없는 회원의 알림 신청이 '신청하지 못했습니다'로 끝난다.
--         20261002000000_phone.sql 보다 먼저 실행하면 실행 자체가 거절된다.
--         여러 번 실행해도 같은 결과가 된다. 이미 신청된 알림은 그대로 둔다.
-- ============================================================
begin;

-- phone 열이 없는데 이 트리거만 만들어지면 모든 알림 신청이 실패한다. 순서를 어기면 여기서 멈춘다.
do $guard$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'phone') then
    raise exception '20261002000000_phone.sql 을 먼저 실행해 주세요.';
  end if;
end $guard$;

create or replace function private.target_alerts_require_phone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = new.user_id and p.phone is not null and p.privacy_agreed_at is not null
  ) then
    raise exception '휴대전화 번호를 먼저 입력해 주세요.' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.target_alerts_require_phone() from public;

drop trigger if exists target_alerts_require_phone on public.target_alerts;
create trigger target_alerts_require_phone
  before insert on public.target_alerts
  for each row execute function private.target_alerts_require_phone();

commit;
