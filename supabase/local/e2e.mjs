// 회원 기능 브라우저 테스트 (실제 인증 서버 + 메일 수신함 + 크로미움)
// 실행: ./up.sh 로 스택을 띄운 뒤  NODE_PATH="$(npm root -g)" node e2e.mjs
// 사이트 파일은 그대로 쓰고, 테스트 중에만 auth-config.js 와 CSP 의 접속 허용 주소를 로컬 서버로 바꾼다.
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const env = Object.fromEntries(readFileSync(new URL('./.env', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const SITE = 'http://localhost:8080';
const API = 'http://localhost:54321';
const MAIL = 'http://localhost:8025';
const SHOTS = new URL('./.run/shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failed += 1;
};
const sql = (q) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '54322', '-U', 'postgres', '-d', 'postgres', '-At', '-c', q],
  { env: { ...process.env, PGPASSWORD: env.POSTGRES_PASSWORD } }).toString().trim();
const stamp = Date.now();
const mail = (n) => `e2e-${n}-${stamp}@example.com`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lastMail(to, { after = 0, subject } = {}) {
  for (let i = 0; i < 40; i += 1) {
    const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const list = (await res.json()).messages || [];
    const hit = list.find((m) => Date.parse(m.Created) > after && (!subject || m.Subject.includes(subject)));
    if (hit) {
      const full = await (await fetch(`${MAIL}/api/v1/message/${hit.ID}`)).json();
      return full;
    }
    await sleep(250);
  }
  return null;
}
const linkIn = (m, needle) => {
  const all = [...m.HTML.matchAll(/href="([^"]+)"/g)].map((x) => x[1].replace(/&amp;/g, '&'));
  return all.find((u) => u.includes(needle));
};

const CONFIG = (over = {}) => `window.SNUCOACH_AUTH = Object.freeze(${JSON.stringify({ url: API, key: env.ANON_KEY, kakao: false, ...over })});`;
async function newContext(browser, { config = CONFIG(), viewport } = {}) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1280, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  ctx.violations = [];
  ctx.errors = [];
  await ctx.route('**/assets/js/auth-config.js*', (route) => route.fulfill({ contentType: 'application/javascript', body: config }));
  await ctx.route(/\/[^/?#]*\.html(\?.*)?$|\/(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace("connect-src 'self' https://*.supabase.co", `connect-src 'self' https://*.supabase.co ${API}`);
    await route.fulfill({ response: res, body });
  });
  await ctx.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  ctx.on('page', (p) => {
    p.on('console', (m) => { if (m.type() === 'error') ctx.errors.push(m.text()); if (/CSP violation/.test(m.text())) ctx.violations.push(m.text()); });
    p.on('pageerror', (e) => ctx.errors.push(String(e)));
  });
  return ctx;
}
async function fillSignup(page, { email, pw = 'abcd1234', name = '테스트학생', type = '학생', grade = '고2', all = true }) {
  await page.fill('#suEmail', email);
  await page.fill('#suPw', pw);
  await page.fill('#suPw2', pw);
  await page.fill('#suName', name);
  await page.check(`#suType input[value="${type}"]`, { force: true });
  await page.selectOption('#suGrade', grade);
  if (all) await page.check('#suConsent [data-agree-all]');
}
const text = async (page, sel) => (await page.locator(sel).textContent() || '').trim();
const visible = (page, sel) => page.locator(sel).isVisible();

// 크롬의 '로컬 네트워크 접근' 검사는 localhost 끼리의 테스트 요청을 막는다(실제 사이트는 공개 https 라 해당 없음).
const browser = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] });
try {
  // ── 0. 설정이 비어 있을 때 ──────────────────────────────
  {
    const ctx = await newContext(browser, { config: CONFIG({ url: '', key: '' }) });
    const page = await ctx.newPage();
    await page.goto(`${SITE}/index.html`);
    check('설정 전: 상단 로그인 메뉴 숨김', !(await visible(page, '.nav-auth')));
    await page.goto(`${SITE}/login.html`);
    await page.waitForSelector('#authMsg:not([hidden])');
    check('설정 전: 로그인 화면에 준비 중 안내', (await text(page, '#authMsg')).includes('준비'));
    check('설정 전: 입력 잠금', await page.locator('#loginEmail').isDisabled());
    const ctx2 = await newContext(browser, { config: CONFIG({ key: env.SERVICE_ROLE_KEY }) });
    const p2 = await ctx2.newPage();
    await p2.goto(`${SITE}/login.html`);
    await p2.waitForSelector('#authMsg:not([hidden])');
    check('비밀 키를 넣으면 회원 기능 정지', (await text(p2, '#authMsg')).includes('보안 설정 오류') && await p2.locator('#loginEmail').isDisabled());
    await ctx.close(); await ctx2.close();

    // 다른 사이트가 로그인 화면을 iframe 으로 감싸면(클릭재킹) 양식을 지운다
    const ctx3 = await newContext(browser);
    await ctx3.route('http://evil.test/', (r) => r.fulfill({ contentType: 'text/html', body: `<iframe src="${SITE}/login.html" width="800" height="600"></iframe>` }));
    const p3 = await ctx3.newPage();
    await p3.goto('http://evil.test/');
    await p3.waitForTimeout(1500);
    const framed = p3.frames().find((f) => f.url().includes('login.html'));
    check('외부 사이트 프레임 안에서는 로그인 양식 제거', !!framed && (await framed.locator('#loginForm').count()) === 0);
    await ctx3.close();
  }

  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());

  // ── 1. 메뉴 ─────────────────────────────────────────────
  await page.goto(`${SITE}/index.html`);
  check('설정 후: 상단 로그인 메뉴 표시', await visible(page, '.nav-auth') && (await text(page, '.nav-auth')) === '로그인');
  await page.goto(`${SITE}/jungsi/`);
  check('하위 폴더(정시)에서도 로그인 링크 경로 정상', (await page.getAttribute('.nav-auth', 'href')) === '../login.html' && await visible(page, '.nav-auth'));

  // ── 2. 회원가입 입력 검사 ───────────────────────────────
  await page.goto(`${SITE}/signup.html`);
  await page.click('#signupForm button[type="submit"]');
  check('빈 가입 양식: 이메일 오류 표시 + 포커스', (await text(page, '#suEmailErr')).length > 0 && await page.evaluate(() => document.activeElement.id) === 'suEmail');
  await fillSignup(page, { email: mail('weak'), pw: 'abcdefgh', all: false });
  await page.click('#signupForm button[type="submit"]');
  check('숫자 없는 비밀번호 거부', (await text(page, '#suPwErr')).includes('영문과 숫자'));
  await page.fill('#suPw', 'abcd1234'); await page.fill('#suPw2', 'abcd1235');
  await page.click('#signupForm button[type="submit"]');
  check('비밀번호 확인 불일치 거부', (await text(page, '#suPw2Err')).includes('서로 다릅니다'));
  await page.fill('#suPw2', 'abcd1234');
  await page.click('#signupForm button[type="submit"]');
  check('필수 동의 없으면 거부', (await text(page, '#suConsentErr')).length > 0);
  await page.check('#suType input[value="학부모"]', { force: true });
  check('학부모 선택 시 "자녀 학년" 라벨', (await text(page, '#signupForm [data-grade-label]')) === '자녀 학년');
  await page.check('#suConsent [data-agree-all]');
  check('전체 동의 → 4개 모두 체크', (await page.locator('#suConsent [data-agree]:checked').count()) === 4);
  await page.uncheck('#suConsent [data-agree="marketing"]');
  check('하나 해제 → 전체 동의 해제', !(await page.isChecked('#suConsent [data-agree-all]')));

  // ── 3. 회원가입 → 인증 메일 → 인증 ──────────────────────
  const A = mail('a');
  await page.goto(`${SITE}/signup.html`);
  await fillSignup(page, { email: A, name: '김스누', type: '학생', grade: '고2' });
  const t0 = Date.now() - 1000;
  await page.click('#signupForm button[type="submit"]');
  await page.waitForSelector('#signupDone:not([hidden])');
  check('가입 후 인증 메일 안내 화면', (await text(page, '#doneEmail')) === A);
  await page.screenshot({ path: `${SHOTS}signup-done.png` });
  const m1 = await lastMail(A, { after: t0 });
  check('한국어 인증 메일 도착', !!m1 && m1.Subject === '[스누코치] 이메일 인증을 완료해 주세요', m1 && m1.Subject);
  const confirmLink = m1 && linkIn(m1, 'token_hash=');
  check('인증 링크는 사이트 account.html + token_hash', !!confirmLink && confirmLink.startsWith(`${SITE}/account.html?token_hash=`) && confirmLink.endsWith('&type=email'), confirmLink);
  check('DB: 인증 전 email_confirmed_at 없음', sql(`select email_confirmed_at is null from auth.users where email='${A}'`) === 't');

  // 다른 브라우저(기기)에서 인증 링크 열기 — token_hash 방식은 기기와 무관하게 동작해야 한다
  const other = await newContext(browser, { viewport: { width: 390, height: 844 } });
  const op = await other.newPage();
  await op.goto(confirmLink);
  await op.waitForSelector('#acct:not([hidden])', { timeout: 15000 });
  check('다른 기기에서 인증 링크 → 바로 로그인 + 마이페이지', (await text(op, '#acctName')) === '김스누');
  check('환영 안내 표시', (await text(op, '#authMsg')).includes('인증이 완료'));
  check('주소창에서 토큰 제거', !op.url().includes('token_hash') && op.url().endsWith('/account.html'), op.url());
  check('DB: 인증 완료', sql(`select email_confirmed_at is not null from auth.users where email='${A}'`) === 't');
  await op.screenshot({ path: `${SHOTS}account-mobile.png`, fullPage: true });
  check('모바일: 가로 스크롤 없음', await op.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  // 같은 링크를 두 번 열면 안내
  const op2 = await other.newPage();
  await op2.goto(confirmLink);
  await op2.waitForSelector('#authMsg:not([hidden])');
  check('이미 쓴 인증 링크 → 만료 안내', (await text(op2, '#authMsg')).includes('만료되었거나 이미 사용'));
  await other.close();

  // ── 4. 로그인 ───────────────────────────────────────────
  await page.goto(`${SITE}/login.html`);
  await page.fill('#loginEmail', A);
  await page.fill('#loginPw', 'wrong1234');
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector('#authMsg:not([hidden])');
  check('틀린 비밀번호 안내', (await text(page, '#authMsg')) === '이메일 또는 비밀번호가 맞지 않습니다.');
  await page.fill('#loginPw', 'abcd1234');
  await page.click('#loginForm button[type="submit"]');
  await page.waitForURL('**/account.html');
  await page.waitForSelector('#acct:not([hidden])');
  check('로그인 → 마이페이지', (await text(page, '#acctName')) === '김스누');
  check('배지: 학생·고2', (await text(page, '#acctBadges')).includes('학생') && (await text(page, '#acctBadges')).includes('고2'));
  check('가입 방식: 이메일', (await text(page, '#acctProvider')) === '이메일');
  check('로그인 유지: localStorage 에 세션', await page.evaluate(() => !!localStorage.getItem('snucoach-auth') && !sessionStorage.getItem('snucoach-auth')));
  await page.screenshot({ path: `${SHOTS}account-desktop.png`, fullPage: true });
  await page.goto(`${SITE}/index.html`);
  check('로그인 후 상단 메뉴 "마이페이지"', (await text(page, '.nav-auth')) === '마이페이지' && (await page.getAttribute('.nav-auth', 'href')) === 'account.html');
  await page.goto(`${SITE}/login.html`);
  await page.waitForURL('**/account.html');
  check('로그인 상태로 로그인 화면 → 마이페이지로 이동', page.url().endsWith('/account.html'));

  // ── 5. 내 정보 수정 ─────────────────────────────────────
  await page.waitForSelector('#acct:not([hidden])');
  await page.fill('#pfName', '김스누2');
  await page.selectOption('#pfGrade', '고3');
  await page.click('#profileForm button[type="submit"]');
  await page.waitForSelector('#profileMsg:not([hidden])');
  check('내 정보 저장', (await text(page, '#profileMsg')) === '저장했습니다.' && (await text(page, '#acctName')) === '김스누2');
  check('DB 반영', sql(`select name||','||grade from public.profiles p join auth.users u on u.id=p.id where u.email='${A}'`) === '김스누2,고3');
  await page.fill('#pfName', '');
  await page.click('#profileForm button[type="submit"]');
  check('빈 이름 저장 거부', (await text(page, '#pfNameErr')).length > 0);
  await page.fill('#pfName', '김스누2');

  // ── 6. 마케팅 수신 ──────────────────────────────────────
  check('가입 때 마케팅 동의(전체 동의) 반영', await page.isChecked('#mktToggle'));
  await page.uncheck('#mktToggle', { force: true });
  await page.waitForSelector('#mktMsg:not([hidden])');
  check('수신 거부 처리 결과 안내', (await text(page, '#mktMsg')).includes('수신 거부를 처리'));
  check('DB: 마케팅 철회 기록', sql(`select (not marketing_opt_in) and marketing_opt_in_at > now() - interval '1 minute' from public.profiles p join auth.users u on u.id=p.id where u.email='${A}'`) === 't');

  // ── 7. 비밀번호 변경 ────────────────────────────────────
  await page.click('#pwCard summary');
  await page.fill('#curPw', 'nope12345');
  await page.fill('#chPw', 'newpass123');
  await page.fill('#chPw2', 'newpass123');
  await page.click('#pwForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#curPwErr').textContent.length > 0);
  check('현재 비밀번호 틀리면 거부', (await text(page, '#curPwErr')) === '현재 비밀번호가 맞지 않습니다.');
  await page.fill('#curPw', 'abcd1234');
  await page.click('#pwForm button[type="submit"]');
  await page.waitForSelector('#pwMsg:not([hidden])');
  check('비밀번호 변경 성공', (await text(page, '#pwMsg')).startsWith('비밀번호를 바꿨습니다'), await text(page, '#pwMsg'));

  // ── 7-1. 대학 라인 잡기: 목표 대학 입시 정보 알림 ─────
  {
    const setTargets = (pg, targets) => pg.evaluate((t) => sessionStorage.setItem('jungsi_state_v2', JSON.stringify({ targets: t })), targets);
    // 로그인 전: 안내 → 로그인 → 돌아오면 자동 신청
    const actx = await newContext(browser);
    const ap = await actx.newPage();
    await ap.goto(`${SITE}/jungsi/`);
    await setTargets(ap, [{ univ: '서울대', major: '자연', band: 'up' }, { univ: '부산대', major: '자연', band: 'safe' }]);
    await ap.reload();
    check('정시: 목표 고르면 알림 버튼 표시', await visible(ap, '#tbar-alert'));
    await ap.click('#tbar-alert');
    await ap.waitForSelector('#alertDlg[open]');
    check('알림 창: 대상 대학만 표시 + 대상 아님 안내', (await text(ap, '#adlgList')) === '서울대' && (await text(ap, '#adlgOut')).includes('부산대'));
    check('알림 창: 인서울 주요 대학 한정 안내', (await text(ap, '.adlg-scope')).includes('인서울 주요 대학'));
    check('알림 창: 비회원은 가입·로그인 안내', await visible(ap, '#adlgNeed') && (await ap.getAttribute('#adlgAct a.pri', 'href')) === '../signup.html');
    await ap.screenshot({ path: `${SHOTS}jungsi-alert.png` });
    await ap.click('#adlgAct a.sec');
    await ap.waitForURL('**/login.html?next=*');
    await ap.fill('#loginEmail', A);
    await ap.fill('#loginPw', 'newpass123');
    await ap.click('#loginForm button[type="submit"]');
    await ap.waitForURL('**/jungsi/');
    let got = '';
    for (let i = 0; i < 30 && !got; i += 1) { await sleep(200); got = sql(`select string_agg(univ||':'||coalesce(track,''), ',') from public.target_alerts a join auth.users u on u.id=a.user_id where u.email='${A}'`); }
    check('로그인하고 돌아오면 고른 대학 알림 저장', got === '서울대:자연', got);
    check('보류 신청 지움', await ap.evaluate(() => !localStorage.getItem('snucoach-alert-pending')));
    // 로그인 상태: 바로 신청
    await setTargets(ap, [{ univ: '연세대', major: '인문·사회', band: 'mid' }, { univ: '서울대', major: '자연', band: 'up' }]);
    await ap.reload();
    await ap.click('#tbar-alert');
    await ap.waitForSelector('#alertDlg[open]');
    check('회원: 신청 버튼', (await text(ap, '#adlgAct .pri')) === '2곳 알림 신청하기');
    await ap.click('#adlgAct .pri');
    await ap.waitForSelector('#alertDlg:not([open])', { state: 'attached' });
    check('회원: 신청 저장(중복은 건너뜀)', sql(`select string_agg(univ, ',' order by univ) from public.target_alerts a join auth.users u on u.id=a.user_id where u.email='${A}'`) === '서울대,연세대');
    // 마이페이지에서 확인·해제
    await ap.goto(`${SITE}/account.html`);
    await ap.waitForFunction(() => document.querySelectorAll('#alertList li').length === 2);
    check('마이페이지: 알림 목록', (await text(ap, '#alertList')).includes('연세대'));
    await ap.screenshot({ path: `${SHOTS}account-alerts.png`, fullPage: true });
    await ap.locator('#alertList li', { hasText: '연세대' }).locator('button').click();
    await ap.waitForFunction(() => document.querySelectorAll('#alertList li').length === 1);
    check('마이페이지: 알림 해제', sql(`select string_agg(univ, ',') from public.target_alerts a join auth.users u on u.id=a.user_id where u.email='${A}'`) === '서울대');
    ctx.violations.push(...actx.violations);
    ctx.errors.push(...actx.errors);
    await actx.close();
  }

  // ── 8. 로그아웃 ─────────────────────────────────────────
  await page.click('#acct [data-sign-out]');
  await page.waitForURL('**/index.html');
  check('로그아웃 → 홈, 메뉴 "로그인"', (await text(page, '.nav-auth')) === '로그인' && await page.evaluate(() => !localStorage.getItem('snucoach-auth')));
  await page.goto(`${SITE}/account.html`);
  await page.waitForURL('**/login.html?next=account.html');
  check('비로그인으로 마이페이지 → 로그인 화면', page.url().includes('login.html?next=account.html'));

  // ── 9. 로그인 유지 해제 + next 검사 ────────────────────
  await page.goto(`${SITE}/login.html?next=${encodeURIComponent('https://evil.example/steal')}`);
  await page.fill('#loginEmail', A);
  await page.fill('#loginPw', 'newpass123');
  await page.uncheck('#loginRemember');
  await page.click('#loginForm button[type="submit"]');
  await page.waitForURL('**/account.html');
  check('외부 주소 next 는 무시(오픈 리다이렉트 차단)', page.url() === `${SITE}/account.html`);
  check('새 비밀번호로 로그인', true);
  check('유지 해제: sessionStorage 에만 세션', await page.evaluate(() => !!sessionStorage.getItem('snucoach-auth') && !localStorage.getItem('snucoach-auth')));
  await page.goto(`${SITE}/index.html`);
  check('유지 해제여도 메뉴는 "마이페이지"', (await text(page, '.nav-auth')) === '마이페이지');
  await page.goto(`${SITE}/account.html`);
  await page.waitForSelector('#acct:not([hidden])');
  await page.click('#acct [data-sign-out]');
  await page.waitForURL('**/index.html');

  // ── 10. 인증 전 로그인 + 인증 메일 재발송 ──────────────
  const B = mail('b');
  await page.goto(`${SITE}/signup.html`);
  await fillSignup(page, { email: B, name: '박학부모', type: '학부모', grade: '중1' });
  await page.click('#signupForm button[type="submit"]');
  await page.waitForSelector('#signupDone:not([hidden])');
  await page.goto(`${SITE}/login.html`);
  await page.fill('#loginEmail', B);
  await page.fill('#loginPw', 'abcd1234');
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector('#authMsg .msg-actions button');
  check('인증 전 로그인 → 안내 + 재발송 버튼', (await text(page, '#authMsg')).includes('이메일 인증이 아직'));
  const t1 = Date.now() - 500;
  await page.click('#authMsg .msg-actions button');
  await page.waitForFunction(() => document.querySelector('#authMsg').textContent.includes('다시 보냈습니다'));
  check('인증 메일 재발송', !!(await lastMail(B, { after: t1 })));

  // ── 11. 비밀번호 찾기(한국어 템플릿: token_hash) ───────
  await page.goto(`${SITE}/reset-password.html`);
  await page.waitForSelector('#reqCard:not([hidden])');
  await page.fill('#reqEmail', A);
  const t2 = Date.now() - 500;
  await page.click('#reqForm button[type="submit"]');
  await page.waitForSelector('#reqDone:not([hidden])');
  check('재설정 메일 안내', (await text(page, '#reqDoneEmail')) === A);
  const m2 = await lastMail(A, { after: t2, subject: '비밀번호' });
  check('한국어 재설정 메일 도착', !!m2 && m2.Subject === '[스누코치] 비밀번호 재설정 안내');
  const resetLink = m2 && linkIn(m2, 'token_hash=');
  check('재설정 링크 형식', !!resetLink && resetLink.startsWith(`${SITE}/reset-password.html?token_hash=`) && resetLink.endsWith('&type=recovery'), resetLink);
  const other2 = await newContext(browser);
  const rp = await other2.newPage();
  await rp.goto(resetLink);
  await rp.waitForSelector('#newCard:not([hidden])');
  check('다른 기기에서도 새 비밀번호 화면', !rp.url().includes('token_hash'));
  await rp.fill('#newPw', 'reset1234');
  await rp.fill('#newPw2', 'reset1234');
  await rp.click('#newForm button[type="submit"]');
  await rp.waitForSelector('#newDone:not([hidden])');
  check('비밀번호 재설정 완료', true);
  await other2.close();
  const rp2 = await (await newContext(browser)).newPage();
  await rp2.goto(resetLink);
  await rp2.waitForSelector('#reqCard:not([hidden])');
  check('쓴 재설정 링크 다시 열면 만료 안내', (await text(rp2, '#authMsg')).includes('만료'));
  await page.goto(`${SITE}/login.html`);
  await page.fill('#loginEmail', A);
  await page.fill('#loginPw', 'reset1234');
  await page.click('#loginForm button[type="submit"]');
  await page.waitForURL('**/account.html');
  check('재설정한 비밀번호로 로그인', true);
  await page.waitForSelector('#acct:not([hidden])');
  await page.click('#acct [data-sign-out]');
  await page.waitForURL('**/index.html');

  // ── 12. 기본 메일 템플릿(PKCE ?code=) — 같은 브라우저 / 다른 브라우저 ─
  {
    // 기본 템플릿의 {{ .ConfirmationURL }} 은 인증 서버 /verify 를 거쳐 ?code= 로 돌아온다.
    await page.goto(`${SITE}/reset-password.html`);
    await page.waitForSelector('#reqCard:not([hidden])');
    await page.fill('#reqEmail', A);
    const t3 = Date.now() - 500;
    await page.click('#reqForm button[type="submit"]');
    await page.waitForSelector('#reqDone:not([hidden])');
    const m3 = await lastMail(A, { after: t3, subject: '비밀번호' });
    const th = new URL(linkIn(m3, 'token_hash=')).searchParams.get('token_hash');
    const defaultUrl = `${API}/auth/v1/verify?token=${th}&type=recovery&redirect_to=${encodeURIComponent(`${SITE}/reset-password.html`)}`;
    // 메일 링크 클릭 = 인증 서버 /verify 가 303 으로 사이트에 돌려보냄. (테스트 도구는 리디렉트된 문서의 CSP 를 못 바꿔서 직접 따라간다)
    const follow = async (u) => (await fetch(u, { redirect: 'manual' })).headers.get('location');
    const p3 = await ctx.newPage();
    await p3.goto(await follow(defaultUrl));
    await p3.waitForSelector('#newCard:not([hidden]), #reqCard:not([hidden])');
    check('기본 템플릿 링크(같은 브라우저) → 새 비밀번호 화면', await p3.locator('#newCard').isVisible(), p3.url());
    check('기본 템플릿: 주소창에서 code 제거', !p3.url().includes('code='), p3.url());
    await p3.close();
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });

    // 다른 브라우저: 확인값(code-verifier)이 없어 교환 불가 → 안내
    await page.goto(`${SITE}/reset-password.html`);
    await page.waitForSelector('#reqCard:not([hidden])');
    await page.fill('#reqEmail', A);
    const t4 = Date.now() - 500;
    await page.click('#reqForm button[type="submit"]');
    await page.waitForSelector('#reqDone:not([hidden])');
    const m4 = await lastMail(A, { after: t4, subject: '비밀번호' });
    const th4 = new URL(linkIn(m4, 'token_hash=')).searchParams.get('token_hash');
    const xctx = await newContext(browser);
    const xp = await xctx.newPage();
    await xp.goto(await follow(`${API}/auth/v1/verify?token=${th4}&type=recovery&redirect_to=${encodeURIComponent(`${SITE}/reset-password.html`)}`));
    await xp.waitForSelector('#reqCard:not([hidden])');
    check('기본 템플릿 링크(다른 브라우저) → 같은 브라우저에서 열라는 안내', (await text(xp, '#authMsg')).includes('요청한 브라우저'), await text(xp, '#authMsg'));
    await xctx.close();
  }

  // ── 13. 카카오 등으로 가입해 필수 동의가 없는 회원 → 가입 마무리 ─
  {
    const C = mail('c');
    const r = await fetch(`${API}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: env.SERVICE_ROLE_KEY, authorization: `Bearer ${env.SERVICE_ROLE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: C, password: 'abcd1234', email_confirm: true, user_metadata: { name: '카카오닉네임' } }),
    });
    check('동의 없는 회원 생성(카카오 가입 흉내)', r.status === 200);
    const kctx = await newContext(browser, { config: CONFIG({ kakao: true, google: true }) });
    const kp = await kctx.newPage();
    kp.on('dialog', (d) => d.accept());
    await kp.goto(`${SITE}/login.html`);
    check('google·kakao:true 이면 두 버튼 표시', await visible(kp, '[data-oauth="kakao"]') && await visible(kp, '[data-oauth="google"]'));
    const gp = await kctx.newPage();
    await gp.goto(`${SITE}/login.html`);
    const [authReq] = await Promise.all([
      gp.waitForRequest((r) => r.url().includes('/auth/v1/authorize')),
      gp.click('[data-oauth="google"]'),
    ]);
    const au = new URL(authReq.url());
    check('구글 버튼 → 구글 인증 시작(PKCE, 마이페이지로 복귀)', au.searchParams.get('provider') === 'google'
      && !!au.searchParams.get('code_challenge') && (au.searchParams.get('redirect_to') || '').startsWith(`${SITE}/account.html`), authReq.url());
    await gp.close();
    await kp.screenshot({ path: `${SHOTS}login-kakao.png` });
    await kp.fill('#loginEmail', C);
    await kp.fill('#loginPw', 'abcd1234');
    await kp.click('#loginForm button[type="submit"]');
    await kp.waitForSelector('#onboard:not([hidden])');
    check('가입 마무리 화면 + 닉네임 미리 채움', (await kp.inputValue('#obName')) === '카카오닉네임');
    await kp.click('#onboardForm button[type="submit"]');
    check('마무리: 필수 항목 없으면 거부', (await text(kp, '#obTypeErr')).length > 0 && (await text(kp, '#obConsentErr')).length > 0);
    await kp.check('#obType input[value="기타"]', { force: true });
    await kp.selectOption('#obGrade', '기타');
    await kp.check('#obConsent [data-agree="age"]');
    await kp.check('#obConsent [data-agree="terms"]');
    await kp.check('#obConsent [data-agree="privacy"]');
    await kp.click('#onboardForm button[type="submit"]');
    await kp.waitForSelector('#acct:not([hidden])');
    check('가입 마무리 → 마이페이지', (await text(kp, '#authMsg')).includes('가입이 완료'));
    check('DB: 동의 시각 기록·마케팅 미동의', sql(`select (terms_agreed_at is not null and privacy_agreed_at is not null and age_confirmed_at is not null and not marketing_opt_in) from public.profiles p join auth.users u on u.id=p.id where u.email='${C}'`) === 't');

    // ── 14. 관리자 화면 ──────────────────────────────────
    await kp.goto(`${SITE}/admin.html`);
    await kp.waitForSelector('#authMsg:not([hidden])');
    check('일반 회원은 관리자 화면 거부', (await text(kp, '#authMsg')).startsWith('관리자만 볼 수 있는 페이지입니다.'));
    sql(`update public.profiles set is_admin = true, name = '=HYPERLINK("x")' where id = (select id from auth.users where email='${C}')`);
    await kp.goto(`${SITE}/account.html`);
    await kp.waitForSelector('#acct:not([hidden])');
    check('관리자 배지·관리 링크', (await text(kp, '#acctBadges')).includes('관리자') && await visible(kp, '#adminLink'));
    await kp.click('#adminLink');
    await kp.waitForSelector('#admBody:not([hidden])');
    const rowCount = await kp.locator('#admRows tr').count();
    const total = Number(sql(`select count(*) from auth.users`));
    check('관리자: 전체 회원 목록', rowCount === total, { rowCount, total });
    await kp.fill('#admSearch', A);
    check('관리자: 검색', (await kp.locator('#admRows tr').count()) === 1 && (await text(kp, '#admRows')).includes(A));
    await kp.fill('#admSearch', '');
    await kp.check('#admMkt');
    const mktRows = await kp.locator('#admRows tr').count();
    check('관리자: 마케팅 동의 필터', mktRows === Math.max(1, Number(sql(`select count(*) from public.profiles where marketing_opt_in`))), mktRows);
    await kp.uncheck('#admMkt');
    await kp.screenshot({ path: `${SHOTS}admin.png`, fullPage: true });
    const [dl] = await Promise.all([kp.waitForEvent('download'), kp.click('#admCsv')]);
    const csv = readFileSync(await dl.path(), 'utf8');
    check('CSV: 엑셀용 BOM + 헤더', csv.charCodeAt(0) === 0xFEFF && csv.includes('"가입일시","이름","이메일"'));
    check('CSV: 수식 주입 무력화', csv.includes(`"'=HYPERLINK(""x"")"`), csv.split('\r\n').find((l) => l.includes('HYPERLINK')));
    check('관리자 화면: 이름은 글자로만 표시(HTML 해석 안 함)', (await kp.locator('#admRows a').count()) === 0);
    await kp.waitForSelector('#admAlerts:not([hidden])');
    const alTotal = Number(sql(`select count(*) from public.target_alerts`));
    check('관리자: 알림 신청 목록', (await kp.locator('#alRows tr').count()) === Math.max(1, alTotal) && (await text(kp, '#alRows')).includes(A), alTotal);
    await kp.selectOption('#alUniv', '서울대');
    check('관리자: 대학별 필터', (await text(kp, '#alCount')).startsWith(`${sql(`select count(*) from public.target_alerts where univ='서울대'`)}건`));
    const [dl2] = await Promise.all([kp.waitForEvent('download'), kp.click('#alCsv')]);
    const csv2 = readFileSync(await dl2.path(), 'utf8');
    check('관리자: 알림 CSV', csv2.charCodeAt(0) === 0xFEFF && csv2.includes('"대학","계열","이름","이메일"') && csv2.includes(A));
    await kctx.close();
  }

  // ── 15. 회원 탈퇴 ───────────────────────────────────────
  await page.goto(`${SITE}/login.html`);
  await page.fill('#loginEmail', A);
  await page.fill('#loginPw', 'reset1234');
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector('#acct:not([hidden])');
  await page.click('.danger-zone summary');
  check('탈퇴 버튼은 "탈퇴" 입력 전 잠김', await page.locator('#delBtn').isDisabled());
  await page.fill('#delConfirm', '탈퇴');
  await page.click('#delBtn');
  await page.waitForSelector('#deletedCard:not([hidden])');
  check('탈퇴 완료 화면', true);
  check('DB: 계정·프로필 삭제', sql(`select count(*) from auth.users where email='${A}'`) === '0');
  check('탈퇴 후 메뉴 "로그인" + 저장된 세션 없음', (await text(page, '.nav-auth')) === '로그인' && await page.evaluate(() => !localStorage.getItem('snucoach-auth') && !sessionStorage.getItem('snucoach-auth')));
  await page.goto(`${SITE}/login.html`);
  await page.fill('#loginEmail', A);
  await page.fill('#loginPw', 'reset1234');
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector('#authMsg:not([hidden])');
  check('탈퇴한 계정 로그인 불가', (await text(page, '#authMsg')) === '이메일 또는 비밀번호가 맞지 않습니다.');

  // ── 16. 화면 확인용 스크린샷 + 보안 정책 위반 없음 ─────
  for (const [w, h, tag] of [[390, 844, 'mobile'], [1280, 900, 'desktop']]) {
    const sctx = await newContext(browser, { viewport: { width: w, height: h } });
    const sp = await sctx.newPage();
    for (const f of ['login', 'signup', 'reset-password', 'privacy', 'terms']) {
      const r = await sp.goto(`${SITE}/${f}.html`);
      if (!r || r.status() !== 200) { if (f === 'privacy' || f === 'terms') continue; }
      await sp.waitForTimeout(300);
      await sp.screenshot({ path: `${SHOTS}${f}-${tag}.png`, fullPage: true });
      check(`${tag} ${f}: 가로 스크롤 없음`, await sp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    }
    await sp.goto(`${SITE}/index.html`);
    await sp.screenshot({ path: `${SHOTS}index-top-${tag}.png` });
    if (tag === 'mobile') {
      await sp.click('#navToggle');
      await sp.waitForTimeout(450);
      await sp.screenshot({ path: `${SHOTS}drawer-mobile.png` });
      check('모바일 드로어에 로그인 바로가기', await visible(sp, '.drawer-auth'));
    }
    ctx.violations.push(...sctx.violations);
    ctx.errors.push(...sctx.errors);
    await sctx.close();
  }
  check('보안 정책(CSP) 위반 없음', ctx.violations.length === 0, ctx.violations);
  const realErrors = ctx.errors.filter((e) => !/Failed to load resource: the server responded with a status of (400|401|403|404|422)/.test(e) && !/CSP violation/.test(e));
  check('예상하지 못한 콘솔 오류 없음', realErrors.length === 0, realErrors.slice(0, 5));
} finally {
  await browser.close();
  sql(`delete from auth.users where email like 'e2e-%-${stamp}@example.com'`);
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
