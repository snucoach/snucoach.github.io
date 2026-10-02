-- ============================================================
-- 스누코치 — 회원 후기 기능 되돌리기 (20261003000000_reviews.sql 이 만든 것을 지운다)
--
-- ※ 후기 전체와 숨김·수강 확인 처리 기록, 작성 제한·보류 기록이 지워진다. 되살릴 수 없다.
--    먼저 관리자 화면에서 「CSV 내려받기」와 「처리 기록 CSV」를 받아 둔다.
-- 사이트만 이전으로 되돌릴 때는 이 파일을 실행하지 않아도 된다(표와 함수가 남아 있어도 해가 없다).
-- 여러 번 실행해도 오류가 나지 않는다. 회원 정보(profiles)와 다른 기능은 건드리지 않는다.
-- ============================================================
begin;

do $cron$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule('snucoach-purge-review-records');
  end if;
exception when others then
  null; -- 작업이 없으면 그냥 넘어간다
end $cron$;

drop view if exists public.reviews_public;
drop function if exists public.review_hidden_stats();
drop function if exists public.my_reviews();
drop function if exists public.my_review_status();
drop function if exists public.admin_list_reviews();
drop function if exists public.admin_set_review_hidden(bigint, boolean, text, text);
drop function if exists public.admin_set_review_verified(bigint, boolean);
drop function if exists public.admin_log_review_notice(bigint, text);
drop function if exists public.admin_list_review_log();
drop table if exists public.reviews;            -- 트리거·정책·제약도 함께 지워진다
-- 프로필 표에 붙인 「표시 이름 맞추기」 트리거(프로필 표와 그 밖의 트리거는 그대로 둔다)
do $sync$
begin
  if to_regclass('public.profiles') is not null then
    drop trigger if exists profiles_sync_review_label on public.profiles;
  end if;
end $sync$;
drop function if exists private.reviews_sync_author_label();
drop function if exists private.reviews_before_insert();
drop function if exists private.reviews_after_insert();
drop function if exists private.reviews_before_update();
drop function if exists private.reviews_after_delete();
drop function if exists private.review_author_label(text);
drop function if exists private.review_clean_body(text);
drop function if exists private.purge_review_records();
drop table if exists private.review_quota;
drop table if exists private.review_ban;
drop table if exists private.review_hold;
drop table if exists private.review_moderation_log;

commit;

notify pgrst, 'reload schema';
