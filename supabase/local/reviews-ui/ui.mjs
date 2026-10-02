// 회원 후기 화면 검증: 로컬 정적 서버 + 가짜 Supabase(메모리) + 헤드리스 크롬(CDP). Docker 없이 돈다.
//
//   node supabase/local/reviews-ui/ui.mjs          (크롬 위치가 다르면 CHROME=/경로/chrome, 포트가 겹치면 PORT=8767)
//
// 저장소의 HTML·JS·CSS 를 그대로 내려 주고 auth-config.js 와 Supabase 라이브러리만 가짜로 바꾼다.
// 운영 Supabase 로는 아무것도 보내지 않는다. 캡처는 supabase/local/.run/reviews-ui/ 에 남는다(저장소에 올라가지 않는다).
// 가짜 서버(server.mjs)는 DB 트리거·RLS 를 흉내 낼 뿐이다. 실제 DB 규칙은 reviews-db.mjs(PGlite)와 api-tests.mjs(Docker)가 본다.
import { launch, sleep } from './cdp.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, '..', '.run', 'reviews-ui');
fs.mkdirSync(RUN, { recursive: true });
const PORT = Number(process.env.PORT || 8766);
const SITE = `http://127.0.0.1:${PORT}`;
const srv = spawn('node', [path.join(HERE, 'server.mjs')], { stdio: 'ignore', env: { ...process.env, PORT: String(PORT) } });
await sleep(700);
const br = await launch(path.join(RUN, 'chrome-profile'));
let fail = 0, total = 0;
const ok = (name, cond, got) => { total++; if (!cond) fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  → ' + JSON.stringify(got))); };
const NOW = '2026-10-01T03:00:00Z';
const profile = (o = {}) => ({ id: 'u1', name: '김스누', member_type: '학생', grade: '고2', marketing_opt_in: false, marketing_opt_in_at: null,
  terms_agreed_at: NOW, privacy_agreed_at: NOW, age_confirmed_at: NOW, is_admin: false, created_at: NOW, updated_at: NOW, phone: '01012345678', phone_agreed_at: NOW, marketing_sms_opt_in: false, marketing_sms_opt_in_at: null, ...o });
const USERS = {
  u1: { name: '김스누', email: 'kim@example.com', member_type: '학생', complete: true },
  u2: { name: '이영', email: 'lee@example.com', member_type: '학부모', complete: true },
  u3: { name: '미완', email: 'half@example.com', member_type: null, complete: false },
  u8: { name: '최제한', email: 'ban@example.com', member_type: '학생', complete: true, banned: true },
  u9: { name: '유정원', email: 'admin@example.com', member_type: '기타', complete: true, is_admin: true },
};
const PROGRAMS = ['학습코칭', '생기부 컨설팅', '무료 자료·이벤트', '기타'];
const seed = (n, over = () => ({})) => Array.from({ length: n }, (_, i) => ({ id: i + 1, user_id: `w${i}`, rating: (i % 5) + 1, program: PROGRAMS[i % 4], body: `후기 ${i + 1}번입니다. 계획을 세우는 습관이 잡혔습니다.`, author_label: '박**', created_at: new Date(Date.parse(NOW) + i * 60000).toISOString(), updated_at: new Date(Date.parse(NOW) + i * 60000).toISOString(), ...over(i) }));
const AUTH = JSON.stringify({ refresh_token: 'fake', access_token: 'fake' });
const api = async (p, body) => (await fetch(SITE + p, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })).json();
const all = { errors: [], csp: [] };
async function open(pg, url, server = {}, local = { session: false }, extra = '') {
  await api('/__fake/reset', { users: USERS, ...server });
  await pg.goto(`${SITE}/blank.html`);
  await pg.ev(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('__fake_state', ${JSON.stringify(JSON.stringify(local))}); ${local.session ? `localStorage.setItem('snucoach-auth', ${JSON.stringify(AUTH)});` : ''} ${extra}`);
  pg.errors.length = 0; pg.csp.length = 0;
  await pg.goto(SITE + url);
}
const settle = (pg) => pg.waitFor(`!document.getElementById('member-reviews').hidden`);
const txt = (pg, sel) => pg.ev(`const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.trim() : null;`);
const vis = (pg, sel) => pg.ev(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return !!(r.width || r.height) && getComputedStyle(e).visibility !== 'hidden';`);
const set = (pg, sel, v) => pg.ev(`const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));`);
const click = (pg, sel) => pg.ev(`document.querySelector(${JSON.stringify(sel)}).click();`);
const active = (pg) => pg.ev(`const a = document.activeElement; return a && (a.id || a.tagName + ':' + (a.textContent || '').trim().slice(0, 20));`);
const count = (pg, sel) => pg.ev(`return document.querySelectorAll(${JSON.stringify(sel)}).length;`);
const calls = async (pg, name) => ((await pg.ev(`return JSON.parse(localStorage.getItem('__fake_state'))`)).calls || []).filter((c) => c[0] === name).map((c) => c[1]);
const noise = (e) => /Failed to load resource/.test(e); // 404·500 응답을 브라우저가 콘솔에 남기는 줄(시험에서 일부러 낸 응답)
const clean = (pg, name) => { const errs = pg.errors.filter((e) => !noise(e)); ok(`${name}: 콘솔 오류·CSP 위반 없음`, errs.length === 0 && pg.csp.length === 0, [errs, pg.csp]); all.errors.push(...errs); all.csp.push(...pg.csp); };
const U1 = { session: true, uid: 'u1', profile: profile() };

try {
  const pg = await br.page({ width: 1280, height: 900 });

  // ── 1. 비로그인, 후기 23건 ─────────────────────────────
  await open(pg, '/reviews.html', { reviews: seed(23, (i) => (i === 20 ? { verified: true, program: '학습코칭' } : i === 22 ? { updated_at: '2026-10-02T09:00:00Z' } : {})) });
  await settle(pg);
  ok('1 구역과 히어로 버튼이 보임', (await vis(pg, '#member-reviews')) && (await vis(pg, '#mrvJump')) && (await pg.ev(`return document.getElementById('mrvJump').getAttribute('href')`)) === '#member-reviews');
  ok('1 첫 화면 10건, 최신순, 전체 23건', (await count(pg, '#mrvList > li')) === 10 && (await txt(pg, '#mrvTotal')) === '23건' && (await pg.ev(`return document.querySelector('#mrvList > li').id`)) === 'mrv-23', [await count(pg, '#mrvList > li'), await txt(pg, '#mrvTotal')]);
  ok('1 카드: 별점(글자 대체)·프로그램·가린 이름·날짜·수정됨', await pg.ev(`const li = document.getElementById('mrv-23'); const s = li.querySelector('.mrv-stars'); return s.getAttribute('role') === 'img' && s.getAttribute('aria-label') === '별점 5점 만점에 3점' && s.querySelectorAll('svg.on').length === 3 && s.querySelectorAll('svg').length === 5 && li.querySelector('.badge').textContent === '무료 자료·이벤트' && li.querySelector('.mrv-author').textContent === '박**' && li.querySelector('time').textContent === '2026년 10월 1일' && li.querySelector('.mrv-meta').textContent.endsWith('· 수정됨');`), await txt(pg, '#mrv-23'));
  ok('1 별점이 색만으로 구분되지 않음: 보이는 점수 글자(3점), 꺼진 별에도 윤곽선', await pg.ev(`const li = document.getElementById('mrv-23'); const sc = li.querySelector('.mrv-score'); const off = li.querySelector('.mrv-stars svg:not(.on)'); const cs = getComputedStyle(off); return sc.textContent === '3점' && sc.getAttribute('aria-hidden') === 'true' && sc.getBoundingClientRect().width > 0 && cs.stroke !== 'none' && parseFloat(cs.strokeWidth) >= 1;`));
  ok('1 후기 모음 안내가 칩 줄 바로 위에 늘 보임(받은 경로·골라 실음·게시 기간·내려 달라는 요청)', await pg.ev(`const a = document.getElementById('rvAbout'); const t = document.querySelector('.rv-toolbar'); const r = a.getBoundingClientRect(); return a.nextElementSibling === t && r.height > 0 && !a.closest('details') && /보내 주신 후기와 성적·합격 인증 가운데 스누코치가 골라 실은 것/.test(a.textContent) && /받은 후기를 모두 실은 것은 아닙니다/.test(a.textContent) && /내려 달라고 요청하면 지체 없이 내립니다/.test(a.textContent) && a.querySelector('a').href === 'https://pf.kakao.com/_wiwxmG/chat';`));
  ok('1 수강 확인 배지는 확인된 글에만', (await pg.ev(`return [...document.querySelectorAll('#mrvList .badge.gold')].map((b) => b.closest('li').id + ':' + b.textContent).join()`)) === 'mrv-21:수강 확인');
  ok('1 수정하지 않은 글에는 「수정됨」 없음', !(await txt(pg, '#mrv-22 .mrv-meta')).includes('수정됨'));
  ok('1 쓰기 영역: 로그인 안내 링크', (await pg.ev(`const a = document.querySelector('#mrvWrite a'); return a && a.textContent + '|' + a.getAttribute('href')`)) === '로그인하고 후기 쓰기|login.html?next=reviews.html%23member-reviews' && (await txt(pg, '#mrvWrite .mrv-write-note')) === '후기는 스누코치 회원만 쓸 수 있습니다.');
  ok('1 폼·내가 쓴 후기는 숨김', (await vis(pg, '#mrvForm')) === false && (await vis(pg, '#mrvMine')) === false);
  ok('1 운영 기준 요약이 펼치지 않아도 보임(게시 기간·순서·숨김 기준·이의 제기)', (await vis(pg, '.mrv-rules-lead')) && /작성자가 지우거나 탈퇴할 때까지 최신순.+별점은 순서에 영향을 주지 않습니다.+운영 기준을 어긴 후기만 사유를 기록하고 숨기고.+이의를 제기할 수 있습니다/.test(await txt(pg, '.mrv-rules-lead')) && (await pg.ev(`return document.querySelector('#mrvRules details').open`)) === false);
  ok('1 안내 문구: 가입한 회원이면 누구나·수강 확인 구분', /가입한 회원이면 누구나 쓸 수 있는 후기입니다.+수강 사실을 확인한 후기에만/.test(await txt(pg, '.mrv-sub')));
  await click(pg, '#mrvRules summary');
  await pg.waitFor(`document.getElementById('mrvHiddenStat').textContent !== '확인하는 중입니다.'`);
  ok('1 운영 기준의 숨김 기준이 약관 제10조 제5항 다섯 호와 같음(차별·혐오, 되풀이, 관계없는 글, 코치 성명 제외 포함)', (await count(pg, '.mrv-rules-ol > li')) === 5 && /차별·혐오 표현/.test(await txt(pg, '.mrv-rules-ol')) && /같은 내용을 되풀이해 올린 글/.test(await txt(pg, '.mrv-rules-ol')) && /상담·환불·응대에 관한 경험은 후기로 봅니다/.test(await txt(pg, '.mrv-rules-ol')) && /스누코치 소속 코치의 성명만 적은 것은 제외/.test(await txt(pg, '.mrv-rules-ol')));
  ok('1 운영 기준: 관계자·대가성 후기, 14일 보류, 임시 조치 30일', /운영자와 소속 코치는 회원 후기를 쓰지 않으며/.test(await txt(pg, '.mrv-rules-list')) && /대가를 받고 쓰는 후기는 그 사실을 후기에 밝혀야 합니다/.test(await txt(pg, '.mrv-rules-list')) && /지우면 14일 동안 새 후기를 올릴 수 없습니다/.test(await txt(pg, '.mrv-rules-list')) && /30일 이내로 임시로 숨기고, 그 안에 정하지 못하면 다시 게시합니다/.test(await txt(pg, '.mrv-rules-list')));
  ok('1 운영 기준 자세히: 항목 6개, 숨김 현황, 약관 링크', (await count(pg, '.mrv-rules-list dt')) === 6 && (await txt(pg, '#mrvHiddenStat')) === '지금 숨김 처리된 후기는 없습니다.' && (await pg.ev(`return document.querySelector('.mrv-rules-more a').getAttribute('href')`)) === 'terms.html#reviews', await txt(pg, '#mrvHiddenStat'));
  await click(pg, '#mrvMore');
  await pg.waitFor(`document.querySelectorAll('#mrvList > li').length === 20`);
  ok('1 더 보기 → 20건, 안내 문구, 새로 불러온 첫 카드로 초점', (await txt(pg, '#mrvStatus')) === '후기 10건을 더 불러왔습니다.' && (await active(pg)) === 'mrv-13', [await txt(pg, '#mrvStatus'), await active(pg)]);
  await click(pg, '#mrvMore');
  await pg.waitFor(`document.querySelectorAll('#mrvList > li').length === 23`);
  ok('1 더 보기 두 번 → 23건, 버튼 사라짐, 겹치는 글 없음', (await vis(pg, '#mrvMore')) === false && (await pg.ev(`return new Set([...document.querySelectorAll('#mrvList > li')].map((l) => l.id)).size`)) === 23);
  let reqs = (await api('/__fake/state')).requests;
  ok('1 비로그인: Supabase 라이브러리·auth.js 를 요청하지 않음', !reqs.some((r) => /supabase-js|auth\.js/.test(r)), reqs.filter((r) => /supabase-js|auth\.js/.test(r)));
  ok('1 목록 요청 모양(뷰·칸 8개·id 커서)', reqs.some((r) => r.includes('/rest/v1/reviews_public?select=id,rating,program,body,author,verified,created_at,updated_at&order=id.desc&limit=11')) && reqs.some((r) => r.includes('&id=lt.14')) && reqs.some((r) => r.includes('&id=lt.4')), reqs.filter((r) => r.includes('/rest/')));
  ok('1 로그인 링크를 누르면 「돌아오기」 표시를 남김', await pg.ev(`const a = document.querySelector('#mrvWrite a'); a.addEventListener('click', (e) => e.preventDefault()); a.click(); return Number(sessionStorage.getItem('snucoach-return')) > 0;`));
  await pg.goto(SITE + '/reviews.html'); await settle(pg);
  ok('1 후기 화면이 열리면 남은 표시를 지움', (await pg.ev(`return sessionStorage.getItem('snucoach-return')`)) === null);
  clean(pg, '1');

  // ── 2. 비로그인, 0건 ───────────────────────────────────
  await open(pg, '/reviews.html', { reviews: [] });
  await settle(pg);
  ok('2 0건: 빈 상태 문구, 건수 0건, 더 보기 없음', (await vis(pg, '#mrvEmpty')) && (await txt(pg, '#mrvEmpty')) === '아직 회원 후기가 없습니다. 첫 후기를 남겨 주세요.' && (await txt(pg, '#mrvTotal')) === '0건' && (await vis(pg, '#mrvMore')) === false);
  clean(pg, '2');

  // ── 3. 표 없음(DB 설정 전) · 설정 비어 있음 ─────────────
  await open(pg, '/reviews.html', { mode: 'missing' });
  await sleep(500);
  ok('3 DB 설정 전(404 PGRST205): 구역·히어로 버튼 숨긴 채', (await vis(pg, '#member-reviews')) === false && (await vis(pg, '#mrvJump')) === false);
  ok('3 큐레이션 후기는 그대로(카드 134장)', (await count(pg, '.rv-card')) === 134);
  const heroH0 = await pg.ev(`return document.querySelector('.hero-reviews').getBoundingClientRect().height`);
  await open(pg, '/reviews.html', { reviews: seed(3) });
  await settle(pg);
  ok('3 히어로의 버튼 자리를 미리 잡아 둠: 버튼이 나타나도 히어로 높이가 같음', Math.abs((await pg.ev(`return document.querySelector('.hero-reviews').getBoundingClientRect().height`)) - heroH0) < 1 && (await vis(pg, '#mrvJump')) === true, [heroH0, await pg.ev(`return document.querySelector('.hero-reviews').getBoundingClientRect().height`)]);
  clean(pg, '3');
  await open(pg, '/reviews.html', { emptyConfig: true, reviews: seed(3) });
  await sleep(500);
  reqs = (await api('/__fake/state')).requests;
  ok('3 auth-config.js 가 비어 있으면 아무 요청도 하지 않고 숨김', (await vis(pg, '#member-reviews')) === false && !reqs.some((r) => r.includes('/rest/')));
  clean(pg, '3b');

  // ── 4. 조회 실패(500) ─────────────────────────────────
  await open(pg, '/reviews.html', { mode: 'fail', reviews: seed(3) });
  await settle(pg);
  ok('4 조회 실패: 오류 안내와 다시 시도', (await txt(pg, '#mrvMsg')).startsWith('후기를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.') && (await txt(pg, '#mrvMsg button')) === '다시 시도');
  await api('/__fake/set', { mode: 'ok' });
  await click(pg, '#mrvMsg button');
  await pg.waitFor(`document.querySelectorAll('#mrvList > li').length === 3`);
  ok('4 다시 시도 → 목록, 안내 사라짐', (await vis(pg, '#mrvMsg')) === false);
  clean(pg, '4');
  await open(pg, '/reviews.html', { mode: 'fail', reviews: seed(3) }, U1);
  await settle(pg); await pg.waitFor(`document.getElementById('mrvOpen')`); await sleep(200);
  ok('4 조회 실패 + 로그인: 오류 안내만 보이고 「아직 회원 후기가 없습니다」는 보이지 않음', (await txt(pg, '#mrvMsg')).startsWith('후기를 불러오지 못했습니다.') && (await vis(pg, '#mrvEmpty')) === false, await vis(pg, '#mrvEmpty'));
  ok('4 조회 실패여도 숨김 처리 현황은 따로 읽어 「확인하는 중」에 멈추지 않음', (await txt(pg, '#mrvHiddenStat')) === '지금 숨김 처리된 후기는 없습니다.', await txt(pg, '#mrvHiddenStat'));
  await api('/__fake/set', { mode: 'ok' });
  await click(pg, '#mrvMsg button');
  await pg.waitFor(`document.querySelectorAll('#mrvList > li').length === 3`);
  ok('4 다시 시도 뒤 빈 상태 문구는 계속 숨김', (await vis(pg, '#mrvEmpty')) === false);
  clean(pg, '4b');
  // 더 보기: 실패 안내는 버튼 바로 위에, 다시 누르면 새 카드만 덧붙는다(펼쳐 둔 글 유지)
  await open(pg, '/reviews.html', { reviews: seed(23, (i) => (i === 21 ? { body: '줄이 많은 글\n'.repeat(40) + '끝' } : {})) });
  await settle(pg);
  await click(pg, '#mrv-22 .mrv-toggle');
  await api('/__fake/set', { mode: 'fail' });
  await click(pg, '#mrvMore');
  await pg.waitFor(`document.getElementById('mrvMoreMsg').textContent !== ''`);
  ok('4 더 보기 실패: 안내가 버튼 바로 위에 보임(화면 밖이 아님)', await pg.ev(`const m = document.getElementById('mrvMoreMsg'); const b = document.getElementById('mrvMore'); const mr = m.getBoundingClientRect(), br = b.getBoundingClientRect(); return m.textContent === '후기를 더 불러오지 못했습니다. 잠시 뒤 다시 눌러 주세요.' && m.getAttribute('role') === 'alert' && mr.height > 0 && mr.bottom <= br.top + 1 && br.top - mr.bottom < 40 && document.getElementById('mrvMsg').hidden;`), await pg.ev(`return [document.getElementById('mrvMoreMsg').getBoundingClientRect().bottom, document.getElementById('mrvMore').getBoundingClientRect().top]`));
  await api('/__fake/set', { mode: 'ok' });
  await click(pg, '#mrvMore');
  await pg.waitFor(`document.querySelectorAll('#mrvList > li').length === 20`);
  ok('4 다시 누르면 20건, 실패 안내 사라짐, 펼쳐 둔 글은 그대로 펼쳐져 있음', (await txt(pg, '#mrvMoreMsg')) === '' && (await txt(pg, '#mrv-22 .mrv-toggle')) === '접기' && (await pg.ev(`return !document.querySelector('#mrv-22 .mrv-body').classList.contains('is-clamped')`)) && (await active(pg)) === 'mrv-13', [await txt(pg, '#mrv-22 .mrv-toggle'), await active(pg)]);
  clean(pg, '4c');

  // ── 5. 로그인 상태별 쓰기 영역 ─────────────────────────
  await open(pg, '/reviews.html', { reviews: seed(2) }, { session: true, uid: 'u3', profile: profile({ name: null }) });
  await settle(pg); await pg.waitFor(`document.querySelector('#mrvWrite a')`);
  ok('5 가입 마무리 전: 「가입 마무리하고 후기 쓰기」', (await pg.ev(`const a = document.querySelector('#mrvWrite a'); return a.textContent + '|' + a.getAttribute('href')`)) === '가입 마무리하고 후기 쓰기|account.html');
  ok('5 그 링크를 누르면 「돌아오기」 표시를 남김', await pg.ev(`const a = document.querySelector('#mrvWrite a'); a.addEventListener('click', (e) => e.preventDefault()); a.click(); const v = Number(sessionStorage.getItem('snucoach-return')) > 0; sessionStorage.removeItem('snucoach-return'); return v;`));
  reqs = (await api('/__fake/state')).requests;
  ok('5 로그인 흔적이 있으면 라이브러리와 auth.js?v=a7 을 불러옴', reqs.some((r) => r.includes('supabase-js-2.117.2.js')) && reqs.some((r) => r.includes('/assets/js/auth.js?v=a7')));
  ok('5 후기 화면은 프로필(실명 등)을 읽지 않음', (await calls(pg, 'profiles.select')).length === 0);
  clean(pg, '5');
  await open(pg, '/reviews.html', { reviews: seed(2) }, { session: true, uid: 'u9', profile: profile({ is_admin: true }) });
  await settle(pg); await pg.waitFor(`document.querySelector('#mrvWrite .mrv-write-note') && !/확인하는 중/.test(document.querySelector('#mrvWrite').textContent)`);
  ok('5 관리자 계정: 쓸 수 없다는 안내, 버튼 없음', (await txt(pg, '#mrvWrite')) === '관리자 계정으로는 후기를 쓸 수 없습니다.' && (await count(pg, '#mrvWrite button')) === 0);
  await open(pg, '/reviews.html', { reviews: seed(2) }, { session: true, uid: 'u8', profile: profile() });
  await settle(pg); await pg.waitFor(`document.querySelector('#mrvWrite a')`);
  ok('5 작성 제한 계정: 안내와 카카오톡 채널 링크', /후기 작성이 제한된 계정입니다/.test(await txt(pg, '#mrvWrite')) && (await pg.ev(`return document.querySelector('#mrvWrite a').href`)) === 'https://pf.kakao.com/_wiwxmG/chat');
  const holdUntil = new Date(Date.now() + 10 * 86400000).toISOString();
  const holdDay = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' }).format(new Date(holdUntil));
  await open(pg, '/reviews.html', { reviews: seed(2), holds: { u1: holdUntil } }, U1);
  await settle(pg); await pg.waitFor(`document.querySelector('#mrvWrite a')`);
  ok('5 보류 중(숨김 처리된 후기를 지운 회원): 끝나는 날짜 안내, 「후기 쓰기」 버튼 없음', (await txt(pg, '#mrvWrite')) === `숨김 처리된 후기를 지워서 ${holdDay}까지 새 후기를 올릴 수 없습니다. 이미 올린 후기는 고칠 수 있습니다. 이의가 있으면 카카오톡 채널로 알려 주세요.` && (await count(pg, '#mrvOpen')) === 0, await txt(pg, '#mrvWrite'));
  await open(pg, '/reviews.html', { reviews: seed(2) }, { session: false }, `localStorage.setItem('snucoach-auth', ${JSON.stringify(AUTH)});`);
  await settle(pg); await pg.waitFor(`document.querySelector('#mrvWrite a')`);
  ok('5 로그인 흔적만 남고 세션이 없으면 로그인 안내', (await txt(pg, '#mrvWrite a')) === '로그인하고 후기 쓰기');
  await open(pg, '/reviews.html', { reviews: seed(2), fnMissing: true }, U1);
  await settle(pg); await pg.waitFor(`!/확인하는 중/.test(document.querySelector('#mrvWrite').textContent)`);
  ok('5 회원용 함수가 없으면(옛 DB) 올릴 수 없다는 안내', (await txt(pg, '#mrvWrite')) === '지금은 후기를 올릴 수 없습니다. 잠시 뒤 다시 시도해 주세요.');

  // ── 6. 새 글 쓰기 ─────────────────────────────────────
  await open(pg, '/reviews.html', { reviews: seed(12) }, U1);
  await settle(pg); await pg.waitFor(`document.getElementById('mrvOpen')`);
  ok('6 쓸 수 있는 회원: 「후기 쓰기」 버튼(aria-expanded=false)', (await txt(pg, '#mrvOpen')) === '후기 쓰기' && (await pg.ev(`return document.getElementById('mrvOpen').getAttribute('aria-expanded')`)) === 'false');
  await click(pg, '#mrvOpen');
  ok('6 폼이 열리고 제목으로 초점, 표시 이름 미리 보기 김**', (await vis(pg, '#mrvForm')) && (await active(pg)) === 'mrvFormTitle' && (await txt(pg, '#mrvAuthorPreview')) === '김**' && (await pg.ev(`return document.getElementById('mrvOpen').getAttribute('aria-expanded')`)) === 'true', [await active(pg), await txt(pg, '#mrvAuthorPreview')]);
  ok('6 폼 안내: 즉시 공개·개인정보 금지·숨김 기준·삭제·수집 안내 5줄, 약관 동의 문구', (await count(pg, '#mrvNotice li')) === 5 && /다른 사람의 이름·연락처·학교 같은 개인정보, 본인의 연락처, 허위 사실은 적지 말아 주세요\(숨김 처리될 수 있습니다\)\. 스누코치 소속 코치의 성명만 적는 것은 괜찮습니다/.test(await txt(pg, '#mrvNotice')) && /대가를 받고 쓰는 후기는 그 사실을 후기에 밝혀 주세요/.test(await txt(pg, '#mrvNotice')) && /숨김 처리된 후기를 지우면 14일 동안 새 후기를 올릴 수 없습니다/.test(await txt(pg, '#mrvNotice')) && /이용약관 제10조\(회원 후기\)에 동의한 것으로 봅니다/.test(await txt(pg, '.mrv-agree')));
  await click(pg, '#mrvSubmit');
  await sleep(80);
  ok('6 빈 값 제출: 세 칸 오류, 첫 칸으로 초점, 서버 요청 없음', (await txt(pg, '#mrvProgramErr')) === '이용한 프로그램을 골라 주세요.' && (await txt(pg, '#mrvRateErr')) === '별점을 골라 주세요.' && (await txt(pg, '#mrvBodyErr')) === '후기 내용을 10자 이상 적어 주세요.' && (await active(pg)) === 'mrvProgram' && (await pg.ev(`return document.getElementById('mrvProgram').getAttribute('aria-invalid') + document.getElementById('mrvBody').getAttribute('aria-invalid') + document.getElementById('mrvRate').classList.contains('is-invalid')`)) === 'truetruetrue' && (await calls(pg, 'reviews.insert')).length === 0, [await txt(pg, '#mrvProgramErr'), await txt(pg, '#mrvRateErr'), await txt(pg, '#mrvBodyErr'), await active(pg)]);
  await set(pg, '#mrvProgram', '학습코칭');
  await pg.ev(`document.querySelector('#mrvRate input[value="4"]').click();`);
  ok('6 별점 4: 별 4개 켜짐, 글자 안내, 오류 지움', (await count(pg, '#mrvRate label.on')) === 4 && (await txt(pg, '#mrvRateText')) === '5점 만점에 4점' && (await txt(pg, '#mrvRateErr')) === '');
  await pg.ev(`document.querySelector('#mrvRate input[value="4"]').focus();`);
  await pg.key('ArrowRight');
  ok('6 별점은 방향키로 옮길 수 있음(4 → 5)', (await pg.ev(`return document.querySelector('#mrvRate input:checked').value`)) === '5' && (await txt(pg, '#mrvRateText')) === '5점 만점에 5점');
  await pg.key('ArrowLeft');
  await set(pg, '#mrvBody', '아홉 글자 본문임');
  ok('6 글자 수 표시', (await txt(pg, '#mrvBodyCount')) === '9 / 1,000자', await txt(pg, '#mrvBodyCount'));
  await click(pg, '#mrvSubmit');
  await sleep(80);
  ok('6 9자: 본문 오류만 남고 본문으로 초점', (await txt(pg, '#mrvBodyErr')) === '후기 내용을 10자 이상 적어 주세요.' && (await txt(pg, '#mrvProgramErr')) === '' && (await active(pg)) === 'mrvBody');
  await set(pg, '#mrvBody', '  계획 세우는 습관이 잡혔습니다.\n\n\n\n아쉬운 점은 없었어요 🙂  ');
  ok('6 글자 수는 정리한 뒤 코드 포인트 기준', (await txt(pg, '#mrvBodyCount')) === '32 / 1,000자', await txt(pg, '#mrvBodyCount'));
  await click(pg, '#mrvSubmit');
  await pg.waitFor(`!document.getElementById('mrvMsg').hidden`);
  let c = await calls(pg, 'reviews.insert');
  ok('6 보낸 값: 칸 세 개뿐, 본문 정리됨, select("id")', c.length === 1 && JSON.stringify(Object.keys(c[0].row)) === '["rating","program","body"]' && c[0].row.rating === 4 && c[0].row.body === '계획 세우는 습관이 잡혔습니다.\n\n아쉬운 점은 없었어요 🙂' && c[0].cols === 'id', c);
  ok('6 올린 뒤: 안내와 초점, 폼 닫힘, 목록 맨 위에 「내 후기」, 13건', (await txt(pg, '#mrvMsg')) === '후기를 올렸습니다.' && (await active(pg)) === 'mrvMsg' && (await vis(pg, '#mrvForm')) === false && (await pg.ev(`const li = document.querySelector('#mrvList > li'); return li.id + '|' + [...li.querySelectorAll('.badge')].map((b) => b.textContent).join() + '|' + li.querySelector('.mrv-author').textContent`)) === 'mrv-13|학습코칭,내 후기|김**' && (await txt(pg, '#mrvTotal')) === '13건', [await txt(pg, '#mrvMsg'), await active(pg)]);
  ok('6 「내가 쓴 후기」에 고치기·지우기', (await vis(pg, '#mrvMine')) && (await count(pg, '#mrvMineList > li')) === 1 && (await pg.ev(`return [...document.querySelectorAll('#mrvMineList .mrv-item-actions button')].map((b) => b.textContent).join()`)) === '고치기,지우기');
  await click(pg, '#mrvOpen');
  ok('6 다시 쓰기: 이미 쓴 프로그램은 고를 수 없음', (await pg.ev(`const o = [...document.getElementById('mrvProgram').options].find((x) => x.value === '학습코칭'); return o.disabled + '|' + o.textContent`)) === 'true|학습코칭 (작성함)');
  await click(pg, '#mrvCancel');
  ok('6 취소: 폼 닫고 버튼으로 초점', (await vis(pg, '#mrvForm')) === false && (await active(pg)) === 'mrvOpen');
  // 쓰던 내용 보호
  await click(pg, '#mrvOpen');
  await set(pg, '#mrvProgram', '기타');
  await pg.ev(`document.querySelector('#mrvRate input[value="2"]').click();`);
  await set(pg, '#mrvBody', '쓰다가 만 초안입니다. 지워지면 안 됩니다.');
  await click(pg, '#mrvOpen');
  ok('6 폼이 열린 채 「후기 쓰기」를 다시 눌러도 쓰던 내용이 그대로, 제목으로 초점', (await pg.ev(`return document.getElementById('mrvBody').value + '|' + document.getElementById('mrvProgram').value + '|' + document.querySelector('#mrvRate input:checked').value`)) === '쓰다가 만 초안입니다. 지워지면 안 됩니다.|기타|2' && (await active(pg)) === 'mrvFormTitle' && (await pg.ev(`return document.getElementById('mrvOpen').getAttribute('aria-expanded')`)) === 'true');
  await pg.ev(`document.querySelector('#mrvMineList .mrv-item-actions button').click();`);
  ok('6 새 글을 쓰다가 「고치기」를 누르면 한 번 더 누르라는 안내만(초안 유지)', /쓰던 내용이 있습니다\. 「고치기」를 한 번 더 누르면/.test(await txt(pg, '#mrvFormMsg')) && (await txt(pg, '#mrvFormTitle')) === '후기 쓰기' && (await pg.ev(`return document.getElementById('mrvBody').value`)) === '쓰다가 만 초안입니다. 지워지면 안 됩니다.', await txt(pg, '#mrvFormMsg'));
  await pg.ev(`document.querySelector('#mrvMineList .mrv-item-actions button').click();`);
  ok('6 한 번 더 누르면 고치는 화면으로 바뀜, 「후기 쓰기」는 열린 상태(aria-expanded=true)', (await txt(pg, '#mrvFormTitle')) === '후기 고치기' && (await pg.ev(`return document.getElementById('mrvBody').value`)).startsWith('계획 세우는 습관이') && (await vis(pg, '#mrvFormMsg')) === false && (await pg.ev(`return document.getElementById('mrvOpen').getAttribute('aria-expanded')`)) === 'true');
  await click(pg, '#mrvCancel');
  ok('6 「고치기」로 연 폼을 취소하면 누른 「고치기」 버튼으로 초점', (await active(pg)) === 'BUTTON:고치기' && (await pg.ev(`return document.getElementById('mrvOpen').getAttribute('aria-expanded')`)) === 'false', await active(pg));
  clean(pg, '6');

  // ── 7. 서버 거절 ──────────────────────────────────────
  const fillNew = async (program) => { await click(pg, '#mrvOpen'); await set(pg, '#mrvProgram', program); await pg.ev(`document.querySelector('#mrvRate input[value="5"]').click();`); await set(pg, '#mrvBody', '서버가 거절하는 경우를 확인합니다.'); await click(pg, '#mrvSubmit'); await pg.waitFor(`!document.getElementById('mrvFormMsg').hidden`); };
  for (const [name, error, want] of [
    ['RV001', { code: 'RV001', message: '후기는 하루에 3건까지 쓸 수 있습니다. 내일 다시 시도해 주세요.' }, '후기는 하루에 3건까지 올릴 수 있습니다. 내일 다시 시도해 주세요.'],
    ['코드 없이 메시지만 온 경우', { code: 'P0001', message: '후기는 하루에 3건까지 쓸 수 있습니다. 내일 다시 시도해 주세요.' }, '후기는 하루에 3건까지 올릴 수 있습니다. 내일 다시 시도해 주세요.'],
    ['23505', { code: '23505', message: 'duplicate key value violates unique constraint "reviews_user_program_key"' }, '이 프로그램에는 이미 후기를 남기셨습니다. 「내가 쓴 후기」에서 고칠 수 있습니다.'],
    ['23514 길이', { code: '23514', message: 'new row for relation "reviews" violates check constraint "reviews_body_length"' }, '후기 내용은 10자 이상 1,000자 이하로 적어 주세요.'],
    ['23514 그 밖', { code: '23514', message: 'violates check constraint "reviews_rating_range"' }, '입력한 내용을 다시 확인해 주세요.'],
    ['42501', { code: '42501', message: 'permission denied for table reviews' }, '권한이 없습니다. 다시 로그인해 주세요.'],
    ['RV007', { code: 'RV007', message: '숨김 처리된 후기를 지운 뒤 14일 동안은 새 후기를 올릴 수 없습니다(2026-10-20 12:00 까지).' }, '숨김 처리된 후기를 지운 뒤 14일 동안은 새 후기를 올릴 수 없습니다. 이미 올린 후기는 고칠 수 있습니다.'],
    ['PGRST205', { code: 'PGRST205', message: 'not found' }, '지금은 후기를 올릴 수 없습니다. 잠시 뒤 다시 시도해 주세요.'],
  ]) {
    await api('/__fake/set', { failNext: { kind: 'reviews.insert', error } });
    await fillNew('기타');
    ok(`7 서버 거절 ${name} → 안내 문구, 폼은 열린 채`, (await txt(pg, '#mrvFormMsg')) === want && (await vis(pg, '#mrvForm')) === true, await txt(pg, '#mrvFormMsg'));
    await click(pg, '#mrvCancel');
  }
  // 실제 하루 3건 제한(가짜 서버가 트리거를 흉내)
  for (const p of ['생기부 컨설팅', '무료 자료·이벤트']) { await click(pg, '#mrvOpen'); await set(pg, '#mrvProgram', p); await pg.ev(`document.querySelector('#mrvRate input[value="5"]').click();`); await set(pg, '#mrvBody', `${p} 후기를 하나 더 올립니다.`); await click(pg, '#mrvSubmit'); await pg.waitFor(`document.querySelectorAll('#mrvMineList > li').length === ${p === '생기부 컨설팅' ? 2 : 3}`); }
  await fillNew('기타');
  ok('7 하루 4번째 글: 3건 제한 안내', (await txt(pg, '#mrvFormMsg')) === '후기는 하루에 3건까지 올릴 수 있습니다. 내일 다시 시도해 주세요.');
  await click(pg, '#mrvCancel');
  clean(pg, '7');

  // ── 8. 고치기·지우기 ──────────────────────────────────
  await api('/__fake/op', { uid: 'u9', kind: 'rpc', name: 'admin_set_review_verified', args: { p_id: 13, p_verified: true } });
  await pg.goto(SITE + '/reviews.html'); await settle(pg); await pg.waitFor(`document.querySelectorAll('#mrvMineList > li').length === 3`);
  await pg.ev(`[...document.querySelectorAll('#mrvMineList > li')].find((l) => l.textContent.includes('학습코칭')).querySelector('.mrv-item-actions button').click();`);
  ok('8 고치기: 값이 채워진 폼, 제목·버튼 문구, 수강 확인 안내', (await txt(pg, '#mrvFormTitle')) === '후기 고치기' && (await txt(pg, '#mrvSubmit')) === '고친 내용 저장' && (await pg.ev(`return document.getElementById('mrvProgram').value + '|' + document.querySelector('#mrvRate input:checked').value + '|' + document.getElementById('mrvBody').value`)) === '학습코칭|4|계획 세우는 습관이 잡혔습니다.\n\n아쉬운 점은 없었어요 🙂' && (await txt(pg, '#mrvProgramNote')) === '프로그램을 바꾸면 수강 확인 표시가 해제됩니다.' && (await vis(pg, '#mrvProgramNote')));
  ok('8 고치기: 내 다른 후기의 프로그램은 고를 수 없고 지금 프로그램은 고를 수 있음', (await pg.ev(`return [...document.getElementById('mrvProgram').options].filter((o) => o.value).map((o) => o.value + ':' + o.disabled).join()`)) === '학습코칭:false,생기부 컨설팅:true,무료 자료·이벤트:true,기타:false');
  await set(pg, '#mrvBody', '고쳐 쓴 후기입니다. 여전히 만족합니다.');
  await click(pg, '#mrvSubmit');
  await pg.waitFor(`document.getElementById('mrvMsg').textContent === '후기를 고쳤습니다.'`);
  c = await calls(pg, 'reviews.update');
  ok('8 저장: 그 글만 고침(id 조건), 목록에 「수정됨」', c.length === 1 && c[0].filters.id === 13 && JSON.stringify(Object.keys(c[0].row)) === '["rating","program","body"]' && (await txt(pg, '#mrv-13 .mrv-body')) === '고쳐 쓴 후기입니다. 여전히 만족합니다.' && (await txt(pg, '#mrv-13 .mrv-meta')).endsWith('· 수정됨') && (await count(pg, '#mrv-13 .badge.gold')) === 1, c);
  await pg.ev(`[...document.querySelectorAll('#mrvMineList > li')].find((l) => l.textContent.includes('생기부 컨설팅')).querySelectorAll('.mrv-item-actions button')[1].click();`);
  ok('8 지우기: 한 번 누르면 확인 문구만(아직 지우지 않음), 취소로 초점', (await pg.ev(`return document.querySelector('.mrv-confirm').textContent`)) === '이 후기를 지울까요? 지우면 되돌릴 수 없습니다.' && (await calls(pg, 'reviews.delete')).length === 0 && (await active(pg)) === 'BUTTON:취소', await active(pg));
  await pg.ev(`document.querySelector('.mrv-confirm').parentNode.querySelector('.btn-line').click();`);
  ok('8 취소하면 원래 버튼으로', (await count(pg, '.mrv-confirm')) === 0 && (await count(pg, '#mrvMineList > li')) === 3);
  await pg.ev(`[...document.querySelectorAll('#mrvMineList > li')].find((l) => l.textContent.includes('생기부 컨설팅')).querySelectorAll('.mrv-item-actions button')[1].click();`);
  await pg.ev(`document.querySelector('.mrv-confirm').parentNode.querySelector('.btn-danger').click();`);
  await pg.waitFor(`document.getElementById('mrvMsg').textContent === '후기를 지웠습니다.'`);
  ok('8 두 번째에 지움: 내 후기 2건, 전체 14건', (await calls(pg, 'reviews.delete')).length === 1 && (await count(pg, '#mrvMineList > li')) === 2 && (await txt(pg, '#mrvTotal')) === '14건' && (await active(pg)) === 'mrvMsg', [await count(pg, '#mrvMineList > li'), await txt(pg, '#mrvTotal')]);
  clean(pg, '8');

  // ── 9. 숨김 처리된 본인 글 ────────────────────────────
  await open(pg, '/reviews.html', { reviews: [
    ...seed(3),
    { id: 4, user_id: 'u1', rating: 2, program: '학습코칭', body: '피드백이 늦어서 아쉬웠습니다. 담당 코치 연락처는 010-0000-0000', author_label: '김**', created_at: NOW, updated_at: NOW, hidden_at: NOW, hidden_reason: '개인정보 노출', hidden_note: '다른 사람의 연락처' },
    { id: 5, user_id: 'u1', rating: 5, program: '기타', body: '교재 본문을 통째로 옮겨 적은 글입니다.', author_label: '김**', created_at: NOW, updated_at: NOW, hidden_at: NOW, hidden_reason: '법령 위반', hidden_note: '저작권법 위반: 교재 본문 전재' },
    { id: 7, user_id: 'u1', rating: 1, program: '생기부 컨설팅', body: '권리 침해 신고가 들어온 글입니다. 열 글자 이상.', author_label: '김**', created_at: NOW, updated_at: NOW, hidden_at: NOW, hidden_reason: '임시 조치(권리 침해 신고)', hidden_note: '명예훼손 신고 접수' },
    { id: 6, user_id: 'w9', rating: 1, program: '기타', body: '광고 글입니다 광고 글입니다', author_label: '최**', created_at: NOW, updated_at: NOW, hidden_at: NOW, hidden_reason: '광고·스팸' },
  ] }, U1);
  await settle(pg); await pg.waitFor(`document.querySelectorAll('#mrvMineList > li').length === 3`);
  ok('9 숨긴 글은 공개 목록에 없음(3건)', (await count(pg, '#mrvList > li')) === 3 && (await txt(pg, '#mrvTotal')) === '3건');
  ok('9 본인에게는 숨김 사실과 사유(종류), 이의 제기 링크', (await pg.ev(`const li = [...document.querySelectorAll('#mrvMineList > li')].find((l) => l.textContent.includes('학습코칭')); const n = li.querySelector('.mrv-hidden-note'); return li.classList.contains('is-hidden') && n.textContent + '|' + n.querySelector('a').href`)) === '운영 기준(개인정보 노출)에 따라 숨김 처리되어 다른 사람에게는 보이지 않습니다. 사유: 다른 사람의 연락처 내용을 고친 뒤 카카오톡 채널로 알려 주시면 확인해 다시 게시합니다. 숨김 처리에 이의가 있을 때도 같은 채널로 알려 주세요. 확인한 결과는 알려 드립니다.|https://pf.kakao.com/_wiwxmG/chat', await txt(pg, '#mrvMineList .mrv-hidden-note'));
  ok('9 사유 이름은 약관의 이름 그대로(법령 위반), 관리자가 적은 구체 사유가 보임', /운영 기준\(법령 위반\).+사유: 저작권법 위반: 교재 본문 전재/.test(await pg.ev(`return [...document.querySelectorAll('#mrvMineList > li')].find((l) => l.textContent.includes('교재')).querySelector('.mrv-hidden-note').textContent`)));
  ok('9 임시 조치: 신고 접수·기한(숨긴 날부터 30일)·정하지 못하면 다시 게시·의견 채널', await pg.ev(`const n = [...document.querySelectorAll('#mrvMineList > li')].find((l) => l.textContent.includes('생기부 컨설팅')).querySelector('.mrv-hidden-note'); const t = n.textContent; return /신고가 접수되어 임시로 숨김 처리되었습니다/.test(t) && /10월 31일까지 양쪽의 설명을 확인해 다시 게시할지 정하고/.test(t) && /그때까지 정하지 못하면 다시 게시합니다/.test(t) && /사유: 명예훼손 신고 접수/.test(t) && n.querySelector('a').href === 'https://pf.kakao.com/_wiwxmG/chat';`), await pg.ev(`return [...document.querySelectorAll('#mrvMineList > li')].find((l) => l.textContent.includes('생기부 컨설팅')).querySelector('.mrv-hidden-note').textContent`));
  await click(pg, '#mrvRules summary');
  ok('9 운영 기준의 숨김 현황: 사유별 건수', (await txt(pg, '#mrvHiddenStat')) === '지금 운영 기준에 따라 숨김 처리된 후기는 4건입니다(개인정보 노출 1건, 광고·스팸 1건, 법령 위반 1건, 임시 조치(권리 침해 신고) 1건).', await txt(pg, '#mrvHiddenStat'));
  await pg.ev(`[...document.querySelectorAll('#mrvMineList > li')].find((l) => l.textContent.includes('학습코칭')).querySelector('.mrv-item-actions button').click();`);
  await set(pg, '#mrvBody', '피드백이 늦어서 아쉬웠습니다. 연락처는 지웠습니다.');
  await click(pg, '#mrvSubmit');
  await pg.waitFor(`/후기를 고쳤습니다/.test(document.getElementById('mrvMsg').textContent)`);
  ok('9 숨긴 글을 고쳐도 숨김 유지 + 고쳤다고 알려 달라는 안내', (await txt(pg, '#mrvMsg')) === '후기를 고쳤습니다. 아직 숨김 처리된 상태입니다. 고쳤다고 카카오톡 채널로 알려 주시면 확인해 다시 게시합니다.' && (await count(pg, '#mrvList > li')) === 3);
  // 숨김 처리된 글을 지우면 14일 보류
  ok('9 지우기 전에는 「후기 쓰기」 버튼이 있음', (await count(pg, '#mrvOpen')) === 1);
  await pg.ev(`[...document.querySelectorAll('#mrvMineList > li')].find((l) => l.textContent.includes('학습코칭')).querySelectorAll('.mrv-item-actions button')[1].click();`);
  ok('9 숨김 처리된 글 지우기: 확인 문구에 14일 보류와 고쳐서 다시 게시를 요청하는 길', (await txt(pg, '.mrv-confirm')) === '이 후기를 지울까요? 지우면 되돌릴 수 없고, 숨김 처리된 후기를 지우면 14일 동안 새 후기를 올릴 수 없습니다. 내용을 고쳐 다시 게시를 요청할 수도 있습니다.' && (await calls(pg, 'reviews.delete')).length === 0, await txt(pg, '.mrv-confirm'));
  await pg.ev(`document.querySelector('.mrv-confirm').parentNode.querySelector('.btn-danger').click();`);
  await pg.waitFor(`/후기를 지웠습니다/.test(document.getElementById('mrvMsg').textContent)`);
  ok('9 지운 뒤: 보류 안내, 「후기 쓰기」 버튼이 사라지고 끝나는 날짜가 보임', (await txt(pg, '#mrvMsg')) === '후기를 지웠습니다. 숨김 처리된 후기를 지워서 14일 동안 새 후기를 올릴 수 없습니다.' && (await count(pg, '#mrvOpen')) === 0 && /숨김 처리된 후기를 지워서 \d+월 \d+일까지 새 후기를 올릴 수 없습니다\. 이미 올린 후기는 고칠 수 있습니다/.test(await txt(pg, '#mrvWrite')) && (await count(pg, '#mrvMineList > li')) === 2, [await txt(pg, '#mrvMsg'), await txt(pg, '#mrvWrite')]);
  await pg.ev(`[...document.querySelectorAll('#mrvMineList > li')].find((l) => l.textContent.includes('교재')).querySelector('.mrv-item-actions button').click();`);
  ok('9 보류 중에도 이미 올린 글은 고치는 폼이 열림', (await vis(pg, '#mrvForm')) && (await txt(pg, '#mrvFormTitle')) === '후기 고치기');
  await click(pg, '#mrvCancel');
  ok('9 「후기 쓰기」 버튼이 없을 때 취소하면 누른 「고치기」 버튼으로 초점(초점이 사라지지 않음)', (await active(pg)) === 'BUTTON:고치기', await active(pg));
  clean(pg, '9');

  // ── 10. XSS · 화면을 깨는 글 ───────────────────────────
  await open(pg, '/reviews.html', { reviews: [
    { id: 1, user_id: 'w1', rating: 5, program: '기타', body: '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script><a href="javascript:window.__xss=3">눌러</a> http://evil.example/x', author_label: '<b onmouseover="window.__xss=4">x</b>', created_at: NOW, updated_at: NOW },
    { id: 2, user_id: 'u1', rating: 1, program: '학습코칭', body: '"><svg onload=window.__xss=5>' + 'a\n'.repeat(60) + 'W'.repeat(400), author_label: '김**', created_at: NOW, updated_at: NOW, hidden_at: NOW, hidden_reason: '법령 위반', hidden_note: '<img src=x onerror="window.__xss=6">' },
    { id: 3, user_id: 'w3', rating: 3, program: '무료 자료·이벤트', body: '줄이 많은 글\n'.repeat(40) + '끝', author_label: '이**', created_at: NOW, updated_at: NOW },
  ] }, U1);
  await settle(pg); await pg.waitFor(`document.querySelectorAll('#mrvMineList > li').length === 1`);
  ok('10 본문·이름의 태그는 글자 그대로 보이고 실행되지 않음', (await pg.ev(`return [typeof window.__xss, document.querySelectorAll('#member-reviews .mrv-list img, #member-reviews .mrv-list script, #member-reviews .mrv-body a, #member-reviews .mrv-list b').length, document.querySelector('#mrv-1 .mrv-body').textContent.startsWith('<img src=x onerror='), document.querySelector('#mrv-1 .mrv-author').textContent, document.querySelector('#mrvMineList .mrv-hidden-note').textContent.includes('<img src=x onerror=')]`)).join('|') === 'undefined|0|true|<b onmouseover="window.__xss=4">x</b>|true');
  ok('10 줄이 많은 글은 12줄까지만 보이고 「더 보기」', await pg.ev(`const p = document.querySelector('#mrv-3 .mrv-body'); const b = document.querySelector('#mrv-3 .mrv-toggle'); return p.classList.contains('is-clamped') && p.clientHeight < 400 && !!b && b.getAttribute('aria-expanded') === 'false' && b.getAttribute('aria-controls') === p.id;`));
  await click(pg, '#mrv-3 .mrv-toggle');
  ok('10 더 보기 → 전체, 「접기」', await pg.ev(`const p = document.querySelector('#mrv-3 .mrv-body'); const b = document.querySelector('#mrv-3 .mrv-toggle'); return !p.classList.contains('is-clamped') && p.clientHeight > 600 && b.textContent === '접기' && b.getAttribute('aria-expanded') === 'true';`));
  ok('10 짧은 글에는 「더 보기」 없음, 긴 낱말도 가로로 넘치지 않음', (await count(pg, '#mrv-1 .mrv-toggle')) === 0 && (await pg.ev(`return document.documentElement.scrollWidth <= window.innerWidth`)));
  clean(pg, '10');

  // ── 11. 다른 사이트의 프레임 안 ───────────────────────
  await open(pg, '/frame.html', { reviews: seed(3) }, U1);
  await pg.waitFor(`document.getElementById('f').contentDocument && document.getElementById('f').contentDocument.getElementById('member-reviews') && !document.getElementById('f').contentDocument.getElementById('member-reviews').hidden`);
  await sleep(300);
  ok('11 프레임 안: 목록만, 쓰기 영역·내가 쓴 후기 없음', await pg.ev(`const d = document.getElementById('f').contentDocument; return d.querySelectorAll('#mrvList > li').length === 3 && d.getElementById('mrvWrite').children.length === 0 && d.getElementById('mrvMine').hidden;`));
  reqs = (await api('/__fake/state')).requests;
  ok('11 프레임 안에서는 회원 기능을 불러오지 않음', !reqs.some((r) => /supabase-js|auth\.js/.test(r)));

  // ── 12. 관리자 화면 ───────────────────────────────────
  const ADMIN = { session: true, uid: 'u9', profile: profile({ id: 'u9', name: '유정원', is_admin: true }) };
  const admReviews = [
    { id: 1, user_id: 'u1', rating: 5, program: '학습코칭', body: '계획 세우는 습관이 잡혔습니다.', author_label: '김**', created_at: NOW, updated_at: NOW },
    { id: 2, user_id: 'u2', rating: 1, program: '무료 자료·이벤트', body: '=HYPERLINK("http://evil.example","눌러 보세요") 광고입니다', author_label: '이**', created_at: NOW, updated_at: '2026-10-02T01:00:00Z' },
    { id: 3, user_id: 'u8', rating: 2, program: '생기부 컨설팅', body: '기대한 것과 달라서 아쉬웠습니다.\n피드백이 늦었어요.', author_label: '최**', created_at: NOW, updated_at: NOW },
  ];
  await open(pg, '/admin.html', { reviews: admReviews, members: [] }, ADMIN);
  await pg.waitFor(`!document.getElementById('rvBody').hidden && document.querySelectorAll('#rvRows tr').length === 3`);
  ok('12 관리자 목록: 3건, 제목 줄 10칸', (await pg.ev(`return [...document.querySelectorAll('#admReviews thead th')].map((t) => t.textContent).join()`)) === '번호,관리,상태,작성일,별점,프로그램,본문,표시 이름,회원,수강 확인');
  ok('12 줄 내용: 회원 이름·구분·이메일, 작성 제한 표시, 휴대전화 없음', await pg.ev(`const rows = [...document.querySelectorAll('#rvRows tr')].map((tr) => [...tr.cells].map((c) => c.textContent)); const r3 = rows[0], r2 = rows[1]; return r3[0] === '3' && r3[8] === '최제한 · 학생\\nban@example.com\\n작성 제한' && r2[3].includes('수정 10월 2일') && r2[2] === '게시 중' && !document.getElementById('admReviews').textContent.includes('010');`), await pg.ev(`return [...document.querySelectorAll('#rvRows tr')].map((tr) => [...tr.cells].map((c) => c.textContent))`));
  ok('12 수강 확인 버튼은 학습코칭·생기부 컨설팅 후기에만', (await pg.ev(`return [...document.querySelectorAll('#rvRows tr')].map((tr) => tr.cells[0].textContent + ':' + [...tr.cells[1].querySelectorAll('button, a')].map((b) => b.textContent).join('/')).join(' ')`)) === '3:수강 확인/숨김 2:숨김 1:수강 확인/숨김');
  ok('12 「관리」 칸이 가로로 밀지 않아도 표 안에 보임', await pg.ev(`const w = document.querySelector('#rvBody .adm-table-wrap').getBoundingClientRect(); return [...document.querySelectorAll('#rvRows .adm-acts')].every((a) => { const r = a.getBoundingClientRect(); return r.left >= w.left && r.right <= w.right; });`));
  ok('12 관리자 수칙 안내 5줄(같은 잣대·알림과 기록·임시 조치·수강 확인 기준·연락 금지)', (await count(pg, '.adm-rules li')) === 5 && /상담·환불·응대에 관한 불만도 후기입니다/.test(await txt(pg, '.adm-rules')) && /29일이 지난 뒤 자동으로 다시 게시됩니다/.test(await txt(pg, '.adm-rules')) && /별점과 관계없이 같은 잣대/.test(await txt(pg, '.adm-rules')) && /수정·삭제를 부탁하거나 대가를 제시하지 않습니다/.test(await txt(pg, '.adm-rules')));
  // 숨김 창
  await pg.ev(`[...document.querySelectorAll('#rvRows tr')][1].cells[1].querySelector('button').click();`);
  ok('12 숨김 창이 열림(본문 미리 보기, 사유로 초점)', (await pg.ev(`return document.getElementById('rvHideDlg').open`)) && (await txt(pg, '#rvHideBody')).startsWith('글 번호 2 · 별점 1점 · 무료 자료·이벤트 · 이**') && (await active(pg)) === 'rvHideReason');
  await click(pg, '#rvHideOk'); await sleep(60);
  ok('12 사유 없이 → 오류, 요청 없음', (await txt(pg, '#rvHideReasonErr')) === '숨김 사유를 골라 주세요.' && (await calls(pg, 'rpc:admin_set_review_hidden')).length === 0 && (await active(pg)) === 'rvHideReason');
  ok('12 숨김 사유 6개: 약관 제10조 제5항의 이름과 임시 조치', (await pg.ev(`return [...document.getElementById('rvHideReason').options].filter((o) => o.value).map((o) => o.value).join('/')`)) === '욕설·인신공격/광고·스팸/개인정보 노출/허위 사실·권리 침해/법령 위반/임시 조치(권리 침해 신고)' && /후기 문장을 그대로 옮겨 적지 않고/.test(await txt(pg, '#rvHideNoteHint')) && /코치의 성명만 적은 것은 제외/.test(await txt(pg, '#rvHideReasonHint')));
  await set(pg, '#rvHideReason', '임시 조치(권리 침해 신고)');
  ok('12 「임시 조치」를 고르면 메모가 (필수)', (await txt(pg, '#rvHideNoteOpt')) === '(필수)');
  await set(pg, '#rvHideReason', '법령 위반');
  ok('12 「법령 위반」을 고르면 메모가 (필수)', (await txt(pg, '#rvHideNoteOpt')) === '(필수)');
  await click(pg, '#rvHideOk'); await sleep(60);
  ok('12 법령 위반 + 메모 없음 → 오류', (await txt(pg, '#rvHideNoteErr')) === '이 사유는 메모에 구체 사유를 적어 주세요.' && (await calls(pg, 'rpc:admin_set_review_hidden')).length === 0 && (await active(pg)) === 'rvHideNote');
  await set(pg, '#rvHideReason', '광고·스팸');
  await set(pg, '#rvHideNote', '후기와 관계없는 광고 링크');
  await click(pg, '#rvHideOk');
  await pg.waitFor(`!document.getElementById('rvHideDlg').open && /숨김 처리했습니다/.test(document.getElementById('rvMsg').textContent)`);
  c = await calls(pg, 'rpc:admin_set_review_hidden');
  ok('12 숨김 처리: 사유·메모 전달, 상태 칸 변경', c.length === 1 && c[0].p_id === 2 && c[0].p_hidden === true && c[0].p_reason === '광고·스팸' && c[0].p_note === '후기와 관계없는 광고 링크' && (await pg.ev(`return [...document.querySelectorAll('#rvRows tr')][1].cells[2].textContent`)).startsWith('숨김 · 광고·스팸\n후기와 관계없는 광고 링크\n'), c);
  ok('12 숨긴 뒤: 작성자에게 알리라는 안내와 메일 링크(받는 사람·사유·이의 방법)', await pg.ev(`const m = document.getElementById('rvMsg'); const a = m.querySelector('a'); const u = decodeURIComponent(a.getAttribute('href')); return m.textContent.startsWith('숨김 처리했습니다. 오늘 안에 작성자에게 사유와 이의 제기 방법을 알리고, 보낸 뒤 「알림 보냄으로 기록」을 눌러 주세요.') && a.textContent === '작성자에게 메일 쓰기' && u.startsWith('mailto:lee@example.com?subject=[스누코치] 후기 숨김 처리 안내') && u.includes('운영 기준(광고·스팸)') && u.includes('글 번호 2') && u.includes('이의가 있으면') && u.includes('terms.html#reviews') && u.includes('구체 사유: 후기와 관계없는 광고 링크') && u.includes('지우면 14일 동안 새 후기를 올릴 수 없습니다') && m.querySelector('.msg-actions button').textContent === '알림 보냄으로 기록';`), await pg.ev(`return decodeURIComponent(document.querySelector('#rvMsg a').getAttribute('href'))`));
  ok('12 숨긴 글의 관리 칸: 숨김 해제·사유 고치기·작성자에게 알리기', (await pg.ev(`return [...[...document.querySelectorAll('#rvRows tr')][1].cells[1].querySelectorAll('button, a')].map((b) => b.textContent).join('/')`)) === '숨김 해제/사유 고치기/작성자에게 알리기/이의 결과 메일/알림 기록');
  ok('12 숨긴 글에 작성자 알림 기록이 없으면 상태 칸에 표시', (await pg.ev(`return [...document.querySelectorAll('#rvRows tr')][1].cells[2].querySelector('.adm-flag').textContent`)) === '작성자 알림 기록 없음');
  ok('12 아래 줄: 건수와 숨긴 글의 별점 분포', (await txt(pg, '#rvCount')) === '3건 표시 중 (전체 3건 · 게시 중 2 · 숨김 1 · 수강 확인 0 · 확인할 글 1)' && (await txt(pg, '#rvDist')).startsWith('숨긴 글의 별점: 1점 1 · 2점 0 · 3점 0 · 4점 0 · 5점 0 / 게시 중인 글의 별점: 1점 0 · 2점 1'), [await txt(pg, '#rvCount'), await txt(pg, '#rvDist')]);
  ok('12 공개 조회에서 사라짐', (await (await fetch(`${SITE}/rest/v1/reviews_public?select=id`, { headers: { apikey: 'sb_publishable_fake_for_local_check' } })).json()).map((r) => r.id).join() === '3,1');
  // 작성자에게 알렸다는 기록
  await pg.ev(`document.querySelector('#rvMsg .msg-actions button').click();`);
  await pg.waitFor(`/처리 기록에 남겼습니다/.test(document.getElementById('rvMsg').textContent)`);
  c = await calls(pg, 'rpc:admin_log_review_notice');
  ok('12 「알림 보냄으로 기록」: 글 번호와 안내 종류 전달, 상태 칸에 기록 날짜, 「확인할 글」에서 빠짐', c.length === 1 && c[0].p_id === 2 && c[0].p_kind === '숨김 안내' && (await txt(pg, '#rvMsg')) === '「숨김 안내」을 보냈다고 처리 기록에 남겼습니다.' && /작성자 알림 \d+월 \d+일 기록/.test(await pg.ev(`return [...document.querySelectorAll('#rvRows tr')][1].cells[2].textContent`)) && (await pg.ev(`return [...document.querySelectorAll('#rvRows tr')][1].cells[2].querySelectorAll('.adm-flag').length`)) === 0 && (await txt(pg, '#rvCount')).endsWith('· 확인할 글 0)'), [c, await txt(pg, '#rvMsg'), await txt(pg, '#rvCount')]);
  ok('12 이의 결과 메일: 숨김 유지 안내 문안', await pg.ev(`const a = [...[...document.querySelectorAll('#rvRows tr')][1].cells[1].querySelectorAll('a')].find((x) => x.textContent === '이의 결과 메일'); const u = decodeURIComponent(a.getAttribute('href')); return u.startsWith('mailto:lee@example.com?subject=[스누코치] 후기 숨김 처리 이의 검토 결과') && u.includes('숨김 처리를 유지함을 알려 드립니다') && u.includes('운영 기준(광고·스팸)') && u.includes('구체 사유: 후기와 관계없는 광고 링크');`));
  await pg.ev(`[...[...document.querySelectorAll('#rvRows tr')][1].cells[1].querySelectorAll('button')].find((b) => b.textContent === '알림 기록').click();`);
  ok('12 줄의 「알림 기록」: 어떤 안내였는지 고르게 함', (await txt(pg, '.adm-confirm')) === '작성자에게 보낸 안내를 골라 주세요. 처리 기록에 남습니다.' && (await pg.ev(`return [...document.querySelector('.adm-confirm').parentNode.querySelectorAll('button')].map((b) => b.textContent).join('/')`)) === '숨김 안내/이의 검토 결과 안내/그만두기' && (await active(pg)) === 'BUTTON:그만두기');
  await pg.ev(`[...document.querySelector('.adm-confirm').parentNode.querySelectorAll('button')][1].click();`);
  await pg.waitFor(`/「이의 검토 결과 안내」/.test(document.getElementById('rvMsg').textContent)`);
  ok('12 이의 검토 결과 안내 기록', (await calls(pg, 'rpc:admin_log_review_notice')).map((x) => x.p_kind).join() === '숨김 안내,이의 검토 결과 안내');
  // 사유 고치기
  await pg.ev(`[...document.querySelectorAll('#rvRows tr')][1].cells[1].querySelectorAll('button')[1].click();`);
  ok('12 사유 고치기: 지금 값으로 열림', (await txt(pg, '#rvHideTitle')) === '숨김 사유 고치기' && (await pg.ev(`return document.getElementById('rvHideReason').value + '|' + document.getElementById('rvHideNote').value`)) === '광고·스팸|후기와 관계없는 광고 링크' && (await txt(pg, '#rvHideOk')) === '사유 저장');
  await pg.key('Escape'); await sleep(80);
  ok('12 Esc 로 닫히고 누른 버튼으로 초점이 돌아옴', (await pg.ev(`return document.getElementById('rvHideDlg').open`)) === false && (await active(pg)) === 'BUTTON:사유 고치기', await active(pg));
  // 숨김 해제(두 번)
  await pg.ev(`[...document.querySelectorAll('#rvRows tr')][1].cells[1].querySelector('button').click();`);
  ok('12 숨김 해제: 한 번 누르면 확인 문구만', (await txt(pg, '.adm-confirm')) === '다시 게시할까요?' && (await calls(pg, 'rpc:admin_set_review_hidden')).length === 1 && (await active(pg)) === 'BUTTON:그만두기');
  await pg.ev(`document.querySelector('.adm-confirm').parentNode.querySelector('.btn-danger').click();`);
  await pg.waitFor(`/숨김을 해제해 다시 게시했습니다/.test(document.getElementById('rvMsg').textContent)`);
  c = await calls(pg, 'rpc:admin_set_review_hidden');
  ok('12 두 번째에 해제', c.length === 2 && c[1].p_hidden === false && (await pg.ev(`return [...document.querySelectorAll('#rvRows tr')][1].cells[2].textContent`)) === '게시 중');
  ok('12 해제 뒤: 작성자에게 결과를 알리는 메일 문안과 기록 버튼', await pg.ev(`const m = document.getElementById('rvMsg'); const a = m.querySelector('a'); const u = decodeURIComponent(a.getAttribute('href')); return a.textContent === '작성자에게 결과 메일 쓰기' && u.startsWith('mailto:lee@example.com?subject=[스누코치] 후기 다시 게시 안내') && u.includes('숨김 처리를 해제하여 다시 게시했음을 알려 드립니다') && u.includes('글 번호 2') && m.querySelector('.msg-actions button').textContent === '알림 보냄으로 기록';`), await pg.ev(`return decodeURIComponent(document.querySelector('#rvMsg a').getAttribute('href'))`));
  await pg.ev(`document.querySelector('#rvMsg .msg-actions button').click();`);
  await pg.waitFor(`/「해제 결과 안내」/.test(document.getElementById('rvMsg').textContent)`);
  ok('12 해제 결과 안내 기록', (await calls(pg, 'rpc:admin_log_review_notice')).map((x) => x.p_kind).join() === '숨김 안내,이의 검토 결과 안내,해제 결과 안내');
  // 수강 확인
  await pg.ev(`[...document.querySelectorAll('#rvRows tr')][2].cells[1].querySelector('button').click();`);
  await pg.waitFor(`/수강 확인 표시를 붙였습니다/.test(document.getElementById('rvMsg').textContent)`);
  ok('12 수강 확인 표시', (await pg.ev(`return [...document.querySelectorAll('#rvRows tr')][2].cells[9].textContent`)).startsWith('확인 (') && (await pg.ev(`return [...document.querySelectorAll('#rvRows tr')][2].cells[1].querySelector('button').textContent`)) === '확인 취소');
  await pg.ev(`[...document.querySelectorAll('#rvRows tr')][2].cells[1].querySelector('button').click();`);
  ok('12 확인 취소는 한 번 더 묻는다', (await txt(pg, '.adm-confirm')) === '착오로 붙인 수강 확인만 취소합니다. 취소할까요?' && (await calls(pg, 'rpc:admin_set_review_verified')).length === 1);
  await pg.ev(`document.querySelector('.adm-confirm').parentNode.querySelector('.btn-line').click();`);
  ok('12 그만두기 → 원래 버튼', (await count(pg, '.adm-confirm')) === 0 && (await calls(pg, 'rpc:admin_set_review_verified')).length === 1);
  // 검색·상태 필터
  await set(pg, '#rvSearch', 'lee@example.com');
  ok('12 검색(이메일)', (await count(pg, '#rvRows tr')) === 1 && (await txt(pg, '#rvCount')).startsWith('1건 표시 중 (전체 3건'));
  await set(pg, '#rvSearch', '');
  await set(pg, '#rvState', 'hidden');
  ok('12 상태 필터: 숨김 0건이면 빈 줄 안내', (await txt(pg, '#rvRows .adm-empty')) === '조건에 맞는 후기가 없습니다.');
  await set(pg, '#rvState', '');
  // CSV
  await pg.ev(`window.__csv = []; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { b.text().then((t) => window.__csv.push(t)); return o(b); };`);
  await click(pg, '#rvCsv'); await sleep(200);
  let csv = await pg.ev(`return window.__csv[0]`);
  ok('12 CSV: 제목 줄, 수식으로 시작하는 본문은 무력화, 휴대전화 칸 없음', csv.includes('"글 번호","작성일시","수정일시","상태","숨김 사유","숨김 메모","숨김 일시","작성자 알림 기록","확인할 점","별점","프로그램","본문","표시 이름","이름","이메일","회원 구분","수강 확인","수강 확인 일시","작성 제한"') && csv.includes(`"'=HYPERLINK(""http://evil.example"",""눌러 보세요"") 광고입니다"`) && !/휴대전화/.test(csv) && csv.includes('"최제한","ban@example.com","학생","","","제한"'), csv);
  await click(pg, '#rvLogCsv'); await pg.waitFor(`window.__csv.length === 2`);
  csv = await pg.ev(`return window.__csv[1]`);
  ok('12 처리 기록 CSV: 숨김·알림 3번·해제·수강 확인 6줄, 작성자 정보 없음', csv.includes('"처리 일시","글 번호","처리","별점","프로그램","사유","메모","처리한 관리자","후기"') && csv.split('\r\n').length === 7 && csv.includes('"숨김 해제"') && csv.includes('"수강 확인"') && csv.includes('"작성자 알림"') && csv.includes('"해제 결과 안내"') && !csv.includes('lee@example.com') && csv.includes('admin@example.com'), csv);
  // 작성자가 지운 글
  await api('/__fake/op', { uid: 'u2', kind: 'reviews.delete', filters: { id: 2 } });
  await pg.ev(`[...document.querySelectorAll('#rvRows tr')][1].cells[1].querySelector('button').click();`);
  await set(pg, '#rvHideReason', '광고·스팸');
  await click(pg, '#rvHideOk');
  await pg.waitFor(`!document.getElementById('rvHideMsg').hidden`);
  ok('12 작성자가 그 사이 지운 글: 안내', (await txt(pg, '#rvHideMsg')) === '후기를 찾을 수 없습니다. 작성자가 지웠을 수 있습니다.');
  await click(pg, '#rvHideCancel');
  clean(pg, '12');

  // ── 12b. 관리자 화면: 다시 살펴볼 글 ───────────────────
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  await open(pg, '/admin.html', { members: [], reviews: [
    { id: 10, user_id: 'u1', rating: 1, program: '학습코칭', body: '숨긴 뒤에 작성자가 고친 글입니다.', author_label: '김**', created_at: ago(5), updated_at: ago(1), hidden_at: ago(3), hidden_reason: '욕설·인신공격', hidden_note: '특정 코치에 대한 욕설' },
    { id: 11, user_id: 'u1', rating: 5, program: '기타', body: '다른 글이 숨겨진 뒤에 올린 글입니다.', author_label: '김**', created_at: ago(2), updated_at: ago(2) },
    { id: 12, user_id: 'u2', rating: 2, program: '생기부 컨설팅', body: '권리 침해 신고가 들어온 글입니다.', author_label: '이**', created_at: ago(40), updated_at: ago(40), hidden_at: ago(25), hidden_reason: '임시 조치(권리 침해 신고)', hidden_note: '명예훼손 신고 접수' },
    { id: 13, user_id: 'u8', rating: 4, program: '학습코칭', body: '살펴볼 것이 없는 보통 글입니다.', author_label: '최**', created_at: ago(9), updated_at: ago(9) },
    { id: 14, user_id: 'u9', rating: 5, program: '학습코칭', body: '관리자가 되기 전에 쓴 글입니다.', author_label: '유**', created_at: ago(30), updated_at: ago(30) },
  ] }, ADMIN);
  await pg.waitFor(`!document.getElementById('rvBody').hidden && document.querySelectorAll('#rvRows tr').length === 5`);
  const cell = (id, i) => pg.ev(`const tr = [...document.querySelectorAll('#rvRows tr')].find((t) => t.cells[0].textContent === '${id}'); return tr.cells[${i}].textContent;`);
  ok('12b 숨긴 뒤 작성자가 고친 글: 다시 확인하라는 표시', /숨긴 뒤 작성자가 고침\(\d+월 \d+일\)\. 다시 확인해 주세요/.test(await cell(10, 2)) && /작성자 알림 기록 없음/.test(await cell(10, 2)), await cell(10, 2));
  ok('12b 다른 후기를 숨긴 뒤 같은 회원이 올린 글: 표시, 회원 칸에 그 회원의 후기 수', /이 회원의 다른 후기를 숨긴 뒤에 올리거나 고친 글/.test(await cell(11, 2)) && /이 회원의 후기 2건/.test(await cell(11, 8)), [await cell(11, 2), await cell(11, 8)]);
  ok('12b 임시 조치: 기한 날짜와 남은 날(5일)', /임시 조치 기한 \d+월 \d+일/.test(await cell(12, 2)) && /임시 조치 기한이 5일 남았습니다/.test(await cell(12, 2)), await cell(12, 2));
  ok('12b 보통 글에는 표시 없음', (await cell(13, 2)) === '게시 중' && (await cell(14, 2)) === '게시 중');
  ok('12b 건수 줄에 확인할 글 3', (await txt(pg, '#rvCount')).endsWith('· 확인할 글 3)'), await txt(pg, '#rvCount'));
  await set(pg, '#rvState', 'check');
  ok('12b 상태 「확인할 글」: 3건만', (await pg.ev(`return [...document.querySelectorAll('#rvRows tr')].map((t) => t.cells[0].textContent).join()`)) === '12,11,10');
  await set(pg, '#rvState', '');
  ok('12b 임시 조치 안내 메일: 신고 접수·기한·정하지 못하면 다시 게시', await pg.ev(`const tr = [...document.querySelectorAll('#rvRows tr')].find((t) => t.cells[0].textContent === '12'); const a = [...tr.cells[1].querySelectorAll('a')].find((x) => x.textContent === '작성자에게 알리기'); const u = decodeURIComponent(a.getAttribute('href')); return u.startsWith('mailto:lee@example.com?subject=[스누코치] 후기 임시 조치 안내') && u.includes('이용약관 제10조 제8항에 따라') && /[0-9]+월 [0-9]+일까지 임시로 숨김 처리했음을/.test(u) && u.includes('그때까지 정하지 못하면 다시 게시합니다') && u.includes('구체 사유: 명예훼손 신고 접수');`), await pg.ev(`const tr = [...document.querySelectorAll('#rvRows tr')].find((t) => t.cells[0].textContent === '12'); return decodeURIComponent([...tr.cells[1].querySelectorAll('a')][0].getAttribute('href'));`));
  await pg.ev(`const tr = [...document.querySelectorAll('#rvRows tr')].find((t) => t.cells[0].textContent === '14'); [...tr.cells[1].querySelectorAll('button')].find((b) => b.textContent === '숨김').click();`);
  await set(pg, '#rvHideReason', '광고·스팸');
  await click(pg, '#rvHideOk');
  await pg.waitFor(`!document.getElementById('rvHideMsg').hidden`);
  ok('12b 관리자가 자기 계정으로 쓴 글은 처리할 수 없다는 안내', (await txt(pg, '#rvHideMsg')) === '본인 계정으로 쓴 후기는 직접 처리할 수 없습니다.');
  await click(pg, '#rvHideCancel');
  clean(pg, '12b');

  // ── 13. 관리자 화면, 후기용 DB 설정 전 · 옛 화면 ────────
  await open(pg, '/admin.html', { reviews: [], members: [], fnMissing: true }, ADMIN);
  await pg.waitFor(`!document.getElementById('admReviews').hidden`);
  ok('13 후기용 DB 설정 전: 안내만, 표는 숨김', (await txt(pg, '#rvMsg')) === '회원 후기용 데이터베이스 설정(20261003000000_reviews.sql)이 아직 적용되지 않았습니다.' && (await pg.ev(`return document.getElementById('rvMsg').className`)) === 'auth-msg is-info' && (await vis(pg, '#rvBody')) === false);
  ok('13 회원 목록은 그대로 보임', (await vis(pg, '#admBody')) === true);
  clean(pg, '13');
  await open(pg, '/old/admin.html', { reviews: admReviews, members: [] }, ADMIN);
  await pg.waitFor(`!document.getElementById('admBody').hidden`); await sleep(200);
  ok('13 옛 관리자 화면 + 새 auth.js: 후기 구역 없이 그대로 동작', (await count(pg, '#admReviews')) === 0 && (await calls(pg, 'rpc:admin_list_reviews')).length === 0);
  clean(pg, '13b');
  await open(pg, '/admin.html', { reviews: admReviews, members: [] }, U1);
  await pg.waitFor(`!document.getElementById('authMsg').hidden`); await sleep(200);
  ok('13 일반 회원이 관리자 화면을 열면 거절 안내, 후기 목록 요청 없음', /관리자만 볼 수 있는 페이지입니다/.test(await txt(pg, '#authMsg')) && (await calls(pg, 'rpc:admin_list_reviews')).length === 0);

  // ── 14. 기존 큐레이션 후기 동작 ───────────────────────
  await open(pg, '/reviews.html', { reviews: seed(12) });
  await settle(pg);
  ok('14 큐레이션 카드 134장, 열 배치', (await count(pg, '.rv-masonry .rv-card')) === 134 && (await count(pg, '.rv-masonry .rv-col')) === 3);
  const chipCat = await pg.ev(`const c = document.querySelectorAll('#rvChips .chip')[2]; c.click(); return c.dataset.cat;`);
  ok('14 칩 필터가 그대로 동작', await pg.ev(`const cards = [...document.querySelectorAll('.rv-masonry .rv-card')]; return cards.length > 0 && cards.length < 134 && cards.every((c) => c.dataset.cat === ${JSON.stringify(chipCat)});`));
  await pg.ev(`document.querySelector('#rvChips .chip').click(); document.querySelector('.rv-masonry .nb-img').click();`);
  ok('14 라이트박스가 그대로 열림', (await pg.ev(`return document.getElementById('lightbox').open`)) === true);
  await pg.ev(`document.getElementById('lightbox').close(); document.getElementById('member-reviews').scrollIntoView({ behavior: 'instant' }); window.scrollBy({ top: 300, behavior: 'instant' });`);
  await sleep(250);
  ok('14 칩 줄이 회원 후기 구역 위로 따라오지 않음', await pg.ev(`const r = document.querySelector('.rv-toolbar').getBoundingClientRect(); return r.bottom <= 0;`), await pg.ev(`return document.querySelector('.rv-toolbar').getBoundingClientRect().top`));
  ok('14 회원 후기 카드는 스크롤 리빌·라이트박스 대상이 아님', await pg.ev(`return document.querySelectorAll('#member-reviews [data-rv], #member-reviews .nb-img, #member-reviews .rv-card').length === 0 && getComputedStyle(document.querySelector('#mrvList > li')).opacity === '1';`));
  await open(pg, '/reviews.html#member-reviews', { reviews: seed(12) });
  await settle(pg); await sleep(300);
  ok('14 도착한 위치에서 위쪽 후기 모음의 칩 줄이 「회원 후기」 제목 위에 보이지 않음', await pg.ev(`const t = document.querySelector('.rv-toolbar'); const r = t.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, Math.max(0, r.bottom - 6)); const title = document.getElementById('mrvTitle').getBoundingClientRect(); return (!e || !t.contains(e)) && title.top > 0 && title.top < 260;`), await pg.ev(`const r = document.querySelector('.rv-toolbar').getBoundingClientRect(); return [r.top, r.bottom, document.getElementById('mrvTitle').getBoundingClientRect().top]`));
  ok('14 #member-reviews 로 들어오면 그 구역으로 이동', await pg.ev(`const r = document.getElementById('member-reviews').getBoundingClientRect(); return r.top < window.innerHeight && r.top > -50;`), await pg.ev(`return document.getElementById('member-reviews').getBoundingClientRect().top`));
  clean(pg, '14');

  // ── 로그인 뒤 돌아오기(마이페이지) ─────────────────────
  await open(pg, '/account.html', {}, U1, `sessionStorage.setItem('snucoach-return', String(Date.now()));`);
  await pg.waitFor(`location.pathname.endsWith('/reviews.html')`);
  ok('R1 후기 화면에서 로그인하러 온 회원: 마이페이지에서 후기 화면으로 되돌아감', (await pg.ev(`return location.pathname + location.hash`)) === '/reviews.html#member-reviews');
  await open(pg, '/account.html', {}, U1);
  await pg.waitFor(`!document.getElementById('acct').hidden`);
  ok('R2 표시가 없으면 마이페이지 그대로', (await pg.ev(`return location.pathname`)) === '/account.html');
  await open(pg, '/account.html', {}, U1, `sessionStorage.setItem('snucoach-return', String(Date.now() - 31 * 60 * 1000));`);
  await pg.waitFor(`!document.getElementById('acct').hidden`);
  ok('R3 30분이 지난 표시는 쓰지 않고 지움', (await pg.ev(`return location.pathname + '|' + sessionStorage.getItem('snucoach-return')`)) === '/account.html|null');
  await open(pg, '/account.html?welcome=1', {}, U1, `sessionStorage.setItem('snucoach-return', String(Date.now()));`);
  await pg.waitFor(`!document.getElementById('acct').hidden`);
  ok('R4 가입 완료 안내가 있으면 머문다', (await pg.ev(`return location.pathname + '|' + sessionStorage.getItem('snucoach-return')`)) === '/account.html|null' && /가입이 완료되었습니다/.test(await txt(pg, '#authMsg')));
  await open(pg, '/account.html', {}, { session: true, uid: 'u3', profile: profile({ name: null, member_type: null, grade: null, terms_agreed_at: null, privacy_agreed_at: null, age_confirmed_at: null }) }, `sessionStorage.setItem('snucoach-return', 'javascript:alert(1)');`);
  await pg.waitFor(`!document.getElementById('onboard').hidden`);
  ok('R5 가입 마무리 전·이상한 값: 머문다(저장된 값으로 주소를 만들지 않음)', (await pg.ev(`return location.pathname`)) === '/account.html');
  await open(pg, '/account.html', {}, { session: true, uid: 'u3', profile: profile({ name: null, member_type: null, grade: null, terms_agreed_at: null, privacy_agreed_at: null, age_confirmed_at: null }) }, `sessionStorage.setItem('snucoach-return', String(Date.now()));`);
  await pg.waitFor(`!document.getElementById('onboard').hidden`);
  await pg.ev(`const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }; set('obName', '미완성'); if (!document.getElementById('obPhone').closest('.field').hidden) set('obPhone', '010-1234-5678'); document.querySelector('#obType input[value="학생"]').click(); set('obGrade', '고2'); document.querySelector('#obConsent [data-agree-all]').click(); document.querySelector('#onboardForm button[type="submit"]').click();`);
  await pg.waitFor(`!document.getElementById('acct').hidden`);
  ok('R5b 후기 화면에서 가입 마무리를 하러 온 회원: 완료 안내 아래에 「후기 쓰러 가기」(수신 동의 처리 결과 안내는 그대로)', await pg.ev(`const m = document.getElementById('authMsg'); const a = m.querySelector('.msg-actions a'); return location.pathname === '/account.html' && /가입이 완료되었습니다/.test(m.textContent) && !!a && a.textContent === '후기 쓰러 가기' && a.getAttribute('href') === 'reviews.html#member-reviews' && sessionStorage.getItem('snucoach-return') === null;`), await txt(pg, '#authMsg'));
  ok('R6 탈퇴 안내에 「작성한 후기」', /와 작성한 후기가 바로 삭제되며/.test(await pg.ev(`return document.querySelector('.danger-zone').textContent`)));
  clean(pg, 'R');

  // ── 15. 화면 크기 ─────────────────────────────────────
  for (const [w, h] of [[390, 844], [1280, 900]]) {
    const p2 = await br.page({ width: w, height: h, mobile: w < 500 });
    await open(p2, '/reviews.html', { reviews: [
      ...seed(11),
      { id: 12, user_id: 'u1', rating: 4, program: '학습코칭', body: '계획 세우는 습관이 잡혔습니다.\n아쉬운 점은 피드백 시간이 조금 늦었던 것입니다.', author_label: '김**', verified: true, verified_at: NOW, created_at: NOW, updated_at: NOW },
      { id: 13, user_id: 'u1', rating: 2, program: '기타', body: '숨김 처리된 글의 모양을 확인합니다. 열 글자 이상.', author_label: '김**', created_at: NOW, updated_at: NOW, hidden_at: NOW, hidden_reason: '개인정보 노출' },
    ] }, U1);
    await settle(p2); await p2.waitFor(`document.querySelectorAll('#mrvMineList > li').length === 2`);
    await click(p2, '#mrvRules summary');
    await click(p2, '#mrvOpen');
    await p2.ev(`document.querySelector('#mrvRate input[value="4"]').click(); document.getElementById('mrvSubmit').click();`);
    await sleep(150);
    ok(`15 ${w}px: 가로 스크롤 없음`, await p2.ev(`return document.documentElement.scrollWidth <= window.innerWidth`), await p2.ev(`return [document.documentElement.scrollWidth, window.innerWidth]`));
    ok(`15 ${w}px: 별점 누르는 영역 44px 이상`, await p2.ev(`return [...document.querySelectorAll('#mrvRate label')].every((l) => { const r = l.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; })`));
    ok(`15 ${w}px: 버튼·입력 칸이 구역 안에 들어옴`, await p2.ev(`const s = document.querySelector('.mrv-inner').getBoundingClientRect(); return [...document.querySelectorAll('#member-reviews button, #member-reviews select, #member-reviews textarea, #member-reviews .mrv-item, #member-reviews .mrv-rules')].filter((e) => e.getClientRects().length).every((e) => { const r = e.getBoundingClientRect(); return r.left >= s.left - 1 && r.right <= s.right + 1; })`));
    await p2.ev(`document.getElementById('member-reviews').scrollIntoView({ behavior: 'instant' }); window.scrollBy({ top: -110, behavior: 'instant' });`);
    await sleep(400);
    await p2.shot(path.join(RUN, `shot-reviews-${w}.png`), false);
    await p2.ev(`document.getElementById('mrvForm').scrollIntoView({ behavior: 'instant' }); window.scrollBy({ top: -110, behavior: 'instant' });`); await sleep(300);
    await p2.shot(path.join(RUN, `shot-reviews-form-${w}.png`), false);
    await p2.ev(`document.getElementById('mrvMine').scrollIntoView({ behavior: 'instant' }); window.scrollBy({ top: -110, behavior: 'instant' });`); await sleep(300);
    await p2.shot(path.join(RUN, `shot-reviews-mine-${w}.png`), false);
    await p2.ev(`document.getElementById('mrvJump').scrollIntoView({ block: 'center', behavior: 'instant' });`); await sleep(500);
    await p2.shot(path.join(RUN, `shot-reviews-hero-${w}.png`), false);
    clean(p2, `15-${w}`);
    await open(p2, '/admin.html', { reviews: admReviews.map((r) => (r.id === 2 ? { ...r, hidden_at: NOW, hidden_reason: '광고·스팸', hidden_note: '후기와 관계없는 광고 링크' } : r)), members: [] }, ADMIN);
    await p2.waitFor(`!document.getElementById('rvBody').hidden && document.querySelectorAll('#rvRows tr').length === 3`);
    ok(`15 ${w}px 관리자: 페이지 가로 스크롤 없음(표는 안에서 스크롤)`, await p2.ev(`return document.documentElement.scrollWidth <= window.innerWidth`), await p2.ev(`return [document.documentElement.scrollWidth, window.innerWidth]`));
    await p2.ev(`document.getElementById('admReviews').scrollIntoView({ behavior: 'instant' }); window.scrollBy({ top: -110, behavior: 'instant' });`); await sleep(300);
    await p2.shot(path.join(RUN, `shot-admin-${w}.png`), false);
    ok(`15 ${w}px 관리자: 「관리」 칸의 버튼이 가로로 밀지 않아도 보임`, await p2.ev(`const wr = document.querySelector('#rvBody .adm-table-wrap').getBoundingClientRect(); const b = document.querySelector('#rvRows .adm-acts .btn').getBoundingClientRect(); return b.left >= wr.left && b.right <= Math.min(wr.right, window.innerWidth);`), await p2.ev(`const b = document.querySelector('#rvRows .adm-acts .btn').getBoundingClientRect(); return [b.left, b.right, innerWidth]`));
    await p2.ev(`[...document.querySelectorAll('#rvRows tr')][0].cells[1].querySelectorAll('button')[1].click();`); await sleep(300);
    ok(`15 ${w}px 관리자: 숨김 창이 화면 안에 들어옴`, await p2.ev(`const r = document.getElementById('rvHideDlg').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;`), await p2.ev(`const r = document.getElementById('rvHideDlg').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, innerWidth, innerHeight]`));
    await p2.shot(path.join(RUN, `shot-admin-dlg-${w}.png`), false);
    clean(p2, `15-admin-${w}`);
    await p2.close();
  }

  // ── 17. 다른 페이지(회귀): a7 로 정상 동작 ─────────────
  for (const [url, local, ready, name] of [
    ['/login.html', { session: false }, `!!document.getElementById('loginForm')`, 'login'],
    ['/signup.html', { session: false }, `!!document.getElementById('signupForm')`, 'signup'],
    ['/account.html', U1, `!document.getElementById('acct').hidden`, 'account'],
    ['/reset-password.html', { session: false }, `!document.getElementById('reqCard').hidden`, 'reset'],
    ['/terms.html', { session: false }, `!!document.getElementById('reviews')`, 'terms'],
    ['/privacy.html', { session: false }, `document.querySelectorAll('h2').length > 10`, 'privacy'],
    ['/jungsi/', U1, `!!document.querySelector('script[src^="app.js"]')`, 'jungsi'],
  ]) {
    await open(pg, url, {}, local);
    await pg.waitFor(ready); await sleep(250);
    ok(`17 ${name}: 열림`, true);
    ok(`17 ${name}: auth.css·auth.js 버전 a7(a6 없음)`, await pg.ev(`const h = document.documentElement.outerHTML; return !/v=a6/.test(h);`));
    clean(pg, `17-${name}`);
  }
  await open(pg, '/login.html?next=reviews.html%23member-reviews', { reviews: seed(2) }, { session: false, uid: 'u1', profile: profile() });
  await pg.waitFor(`!!document.getElementById('loginForm')`);
  await pg.ev(`document.getElementById('loginEmail').value = 'kim@example.com'; document.getElementById('loginPw').value = 'abcd1234'; document.querySelector('#loginForm button[type="submit"]').click();`);
  await pg.waitFor(`location.pathname.endsWith('/reviews.html')`);
  await settle(pg); await pg.waitFor(`document.getElementById('mrvOpen')`);
  ok('17 이메일 로그인: next 를 따라 후기 화면의 구역으로 돌아와 「후기 쓰기」가 보임', (await pg.ev(`return location.pathname + location.hash`)) === '/reviews.html#member-reviews');
} catch (e) {
  fail++;
  console.log('FAIL (예외) ' + (e && e.stack || e));
} finally {
  await br.close();
  srv.kill();
}
console.log(fail ? `\n${fail} FAILED / ${total}` : `\nALL PASSED (${total})`);
process.exit(fail ? 1 : 0);
