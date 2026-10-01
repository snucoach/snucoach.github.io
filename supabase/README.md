# 스누코치 회원 기능 설정 가이드

홈페이지(GitHub Pages)는 정적 사이트라서 데이터베이스를 직접 둘 수 없다.
회원 계정·DB는 **Supabase**(무료 플랜)에 두고, 사이트는 브라우저에서 Supabase와 통신한다.
이 문서 순서대로 한 번 설정하면 회원가입·로그인·마이페이지·비밀번호 찾기·회원 탈퇴·관리자 회원 목록이 동작한다.

예상 소요 시간: 30~40분 (카카오 로그인 제외)

---

## 0. 무엇이 어디에 있나

| 경로 | 내용 |
|---|---|
| `login.html` `signup.html` `reset-password.html` `account.html` `admin.html` | 로그인 · 회원가입 · 비밀번호 찾기 · 마이페이지 · 회원 관리(관리자) |
| `privacy.html` `terms.html` | 개인정보처리방침 · 이용약관 (모든 페이지 푸터에 링크) |
| `assets/js/auth-config.js` | **Supabase 주소와 공개 키를 넣는 유일한 파일** |
| `assets/js/auth.js` | 회원 기능 로직 |
| `assets/vendor/supabase-js-2.117.2.js` | Supabase 공식 라이브러리(외부 CDN 대신 사이트에 직접 보관) |
| `supabase/migrations/20261001000000_members.sql` | 데이터베이스 설정(테이블·보안 규칙·탈퇴·관리자 기능) |
| `supabase/templates/` | 한국어 인증·비밀번호 재설정 메일 |
| `.github/workflows/supabase-keepalive.yml` | 무료 플랜 일시정지 방지(매일 1회 호출) |
| `supabase/local/` | 개발용 로컬 테스트 환경(실제 서비스와 무관) |

설정 전에는 상단 ‘로그인’ 메뉴가 숨겨져 있고, 회원 페이지에 들어가면 ‘준비 중’ 안내가 나온다.

---

## 1. Supabase 프로젝트 만들기

1. https://supabase.com 가입 → **New project**
2. 입력
   - Name: `snucoach`
   - Database Password: **Generate** 로 만들고 안전한 곳에 보관(사이트에는 절대 넣지 않음)
   - Region: **Northeast Asia (Seoul)** ← 개인정보처리방침에 ‘서울 리전’으로 적었으므로 반드시 서울
   - Plan: Free
3. 프로젝트가 만들어질 때까지 1~2분 기다린다.

## 2. 데이터베이스 설정 (SQL 한 번 실행)

1. 왼쪽 메뉴 **SQL Editor** → **New query**
2. `supabase/migrations/20261001000000_members.sql` 파일 내용을 **전부** 복사해 붙여 넣고 **Run**
3. 결과가 `Success` 이면 끝. (여러 번 실행해도 같은 결과가 되도록 만들어 두었다)

만들어지는 것: 회원 프로필 표, 본인 정보만 보이게 하는 보안 규칙(RLS), 회원 탈퇴 함수, 관리자 회원 목록 함수, 3개월 지난 로그인 기록 자동 삭제 작업.

## 3. 로그인 설정

### 3-1. 주소 (Authentication → URL Configuration)
- **Site URL**: `https://snucoach.github.io`
- **Redirect URLs** → Add URL: `https://snucoach.github.io/**`

### 3-2. 이메일 로그인 (Authentication → Sign In / Providers → Email)
- Enable Email provider: 켬
- **Confirm email: 켬** (인증 메일을 눌러야 가입 완료)
- Secure email change: 켬
- **Minimum password length: 8**
- Password requirements: **Letters and digits**
- Email OTP Expiration: `3600` (1시간. 메일 문구가 ‘1시간 유효’로 되어 있음)

### 3-3. 메일 발송 서버 (필수)
Supabase 기본 메일은 **프로젝트 팀원 주소로만** 보내고 시간당 2통으로 제한된다.
그대로 두면 실제 회원에게 인증 메일이 가지 않는다(화면에는 ‘지금은 메일을 보낼 수 없어요’가 나옴).
아래처럼 Gmail을 연결한다.

1. 메일을 보낼 Gmail 계정에서 Google 계정 → 보안 → **2단계 인증 켜기**
2. Google 계정 → 보안 → **앱 비밀번호** → 이름 `supabase` → 16자리 비밀번호 복사
3. Supabase → Authentication → **Emails → SMTP Settings** → Enable custom SMTP
   - Sender email: 그 Gmail 주소
   - Sender name: `스누코치`
   - Host: `smtp.gmail.com`
   - Port: `465`
   - Username: 그 Gmail 주소(전체)
   - Password: 2번의 앱 비밀번호
4. 저장 후 Authentication → Rate Limits 에서 이메일 발송 한도(기본 시간당 30통)를 확인한다.

> Gmail 개인 계정은 하루 약 500통까지 보낼 수 있다. 회원이 많아지면 도메인을 사서 Resend 같은 메일 서비스로 바꾼다.
> 보낸 메일은 Gmail ‘보낸편지함’에 남으니 주기적으로 지운다(회원 이메일 주소가 들어 있음).

### 3-4. 한국어 메일 (Authentication → Emails → Templates)
두 개만 바꾸면 된다. 제목(Subject)은 아래 그대로, 본문(Body)은 파일 내용을 통째로 붙여 넣는다.

| 템플릿 | Subject | Body |
|---|---|---|
| **Confirm signup** | `[스누코치] 이메일 인증을 완료해 주세요` | `supabase/templates/confirm-signup.html` |
| **Reset Password** | `[스누코치] 비밀번호 재설정 안내` | `supabase/templates/reset-password.html` |

이 템플릿의 링크는 회원이 **가입한 기기와 다른 기기**(예: PC에서 가입, 휴대폰에서 메일 확인)에서 눌러도 동작한다.
기본 영어 템플릿을 그대로 두면 다른 기기에서 누를 때 실패하므로 꼭 바꾼다.

## 4. 사이트에 키 넣기

Supabase → **Project Settings → API Keys** (또는 Connect 버튼)에서 두 값을 복사한다.

- **Project URL**: `https://xxxxxxxx.supabase.co`
- **Publishable key**: `sb_publishable_...` 로 시작하는 키 (예전 프로젝트는 `anon` `public` 키)

`assets/js/auth-config.js` 의 `url` 과 `key` 에 넣고 커밋한다. (Claude에게 두 값을 알려 주면 대신 넣는다.)

> **절대 넣으면 안 되는 값**: Secret key(`sb_secret_...`), `service_role` 키, DB 비밀번호.
> 이 파일은 누구나 볼 수 있다. 비밀 키가 들어가면 아무나 전체 회원 정보를 읽고 지울 수 있다.
> 실수로 넣으면 사이트가 회원 기능을 멈추고, 매일 도는 GitHub 점검이 실패 메일을 보낸다. 그 즉시 Supabase에서 키를 폐기·재발급한다.

Publishable key는 원래 공개용이다. 회원 정보는 2단계의 보안 규칙(RLS)이 지킨다.

## 5. 관리자 지정

1. 사이트에서 대표 계정으로 회원가입·이메일 인증까지 마친다.
2. SQL Editor 에서 아래를 실행한다(이메일만 바꿔서).

```sql
update public.profiles set is_admin = true
where id = (select id from auth.users where email = '관리자@이메일.com');
```

3. 마이페이지에 ‘회원 관리(관리자)’ 버튼이 생긴다. 회원 목록·검색·CSV 내려받기를 할 수 있다.

## 6. (선택) 카카오 로그인

카카오에서 이메일을 받으려면 **비즈 앱 전환(사업자 정보 등록)** 이 필요하다. Supabase 카카오 연동은 이메일이 있어야 동작한다.

1. https://developers.kakao.com → 내 애플리케이션 → 애플리케이션 추가 (앱 이름 `스누코치`)
2. 앱 설정 → 비즈니스 → **비즈 앱 전환** (사업자등록번호 849-37-01282)
3. 앱 설정 → 플랫폼 → Web → 사이트 도메인 `https://snucoach.github.io`
4. 제품 설정 → 카카오 로그인 → 활성화 ON
   - Redirect URI: `https://<프로젝트 주소>.supabase.co/auth/v1/callback`
   - 동의항목: 닉네임(필수), **카카오계정(이메일) 필수 동의**
   - 보안 → Client Secret 코드 생성 → 활성화
5. Supabase → Authentication → Sign In / Providers → **Kakao** → Enable
   - Kakao Client ID: 카카오 앱의 **REST API 키**
   - Kakao Client Secret: 4번의 Client Secret
6. `assets/js/auth-config.js` 의 `kakao` 를 `true` 로 바꾼다.

카카오로 처음 로그인한 회원은 마이페이지에서 ‘가입 마무리’(이름·회원 구분·학년·약관 동의)를 먼저 하게 된다.

## 7. 일시정지 방지와 유지 관리

- 무료 플랜은 일주일 동안 DB 활동이 거의 없으면 **일시정지**된다(데이터는 보존, 로그인 불가).
  `.github/workflows/supabase-keepalive.yml` 이 매일 한 번 데이터 없는 함수(`ping`)를 호출해 이를 막는다.
- GitHub는 저장소에 60일 동안 커밋이 없으면 예약 작업을 끈다. 꺼졌다는 메일이 오면 저장소 **Actions** 탭에서 다시 켠다.
- 그래도 일시정지되면 Supabase 대시보드에서 **Restore** 를 누른다.
- 회원 기능이 매출에 중요해지면 Pro 플랜(월 25달러, 일시정지 없음·자동 백업)을 검토한다.

## 8. 공개 전 확인할 것 (법적 사항)

아래는 코드로 해결할 수 없는 부분이라 직접 확인이 필요하다. 전문가 검토를 권장한다.

- [ ] `privacy.html` 의 시행일, 개인정보 보호책임자 연락처가 맞는지
- [ ] Supabase 리전을 서울로 만들었는지 (아니면 개인정보처리방침 제5조 수정)
- [ ] 메일 발송에 Gmail이 아닌 다른 서비스를 쓰면 제4·5조의 수탁자 수정
- [ ] 스모어·구글 설문지 등 외부 신청서로 받는 개인정보도 처리방침에 넣을지 결정 (현재는 ‘각 신청서에서 따로 안내’로 범위를 나눠 둠)
- [ ] 마케팅 메일을 실제로 보낼 때: 제목 앞 `(광고)` 표기, 수신거부 방법 안내, 수신 동의 회원에게 **2년마다 동의 여부 재확인** 안내(정보통신망법)
- [ ] 개인정보보호위원회 ‘개인정보 처리방침 만들기’(privacy.go.kr)로 한 번 대조

## 9. 문제 해결

| 증상 | 원인과 조치 |
|---|---|
| ‘지금은 메일을 보낼 수 없어요’ | 3-3 SMTP 미설정. 기본 메일은 팀원에게만 간다 |
| 인증 메일이 안 온다 | 스팸함 확인 → Authentication → Logs 에서 오류 확인 → Gmail 앱 비밀번호 재발급 |
| ‘링크가 만료되었거나 이미 사용되었어요’ | 1시간이 지났거나 이미 누른 링크. 로그인 화면에서 인증 메일 다시 받기 |
| 다른 기기에서 메일 링크를 누르면 실패 | 3-4 한국어 템플릿을 아직 안 바꿈 |
| 로그인 메뉴가 안 보인다 | `auth-config.js` 가 비어 있음. 바꾼 뒤 최대 10분 캐시가 있다 |
| ‘서버에 연결하지 못했어요’ | 프로젝트 일시정지 여부 확인(대시보드 Restore) |
| 회원 관리 화면에 ‘관리자만 볼 수 있는 페이지’ | 5단계 SQL을 실행했는지, 그 계정으로 로그인했는지 확인 |

---

## 개발자용: 로컬 검증

실제 Supabase와 같은 구성(Postgres 17 · 인증 서버 GoTrue · REST · 메일 수신함)을 Docker로 띄워 전체 흐름을 검증한다.

```bash
cd supabase/local
./up.sh                                   # 스택 실행 + 마이그레이션 적용 (사이트: http://localhost:8080)
node api-tests.mjs                        # DB 권한·보안 규칙 검증
NODE_PATH="$(npm root -g)" node e2e.mjs   # 브라우저로 가입~탈퇴 전체 흐름 검증 (Playwright)
./down.sh                                 # 정리
```

메일 수신함: http://localhost:8025
