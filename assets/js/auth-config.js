// 스누코치 회원 기능 설정
// Supabase 대시보드 > Project Settings > API Keys 에서 두 값을 복사해 넣는다.
//   url : Project URL                (예: https://abcdefghijklmnop.supabase.co)
//   key : Publishable key            (sb_publishable_ 로 시작. 예전 프로젝트는 anon public 키)
// 이 두 값은 원래 공개되는 값이다. 회원 정보는 데이터베이스의 행 수준 보안(RLS)이 지킨다.
// ※ 절대 넣으면 안 되는 값: Secret key(sb_secret_…), service_role 키, DB 비밀번호
//    (넣으면 누구나 모든 회원 정보를 읽고 지울 수 있게 된다. auth.js 가 감지하면 동작을 멈춘다.)
// 값이 비어 있으면 로그인 메뉴가 숨겨지고, 회원 페이지에는 '준비 중' 안내가 나온다.
window.SNUCOACH_AUTH = Object.freeze({
  url: 'https://kjllkdorcgbfiqbjcfkd.supabase.co',
  key: 'sb_publishable_7vz-nwkAYXDsOgSfrUuptg_Pzo2GXMq',
  google: false, // 구글 로그인 설정(가이드 6단계)을 마친 뒤 true
  kakao: false   // 카카오 로그인 설정(가이드 7단계)을 마친 뒤 true
});
