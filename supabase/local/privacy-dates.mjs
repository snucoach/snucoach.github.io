// 개인정보처리방침(privacy.html)의 공고일·시행일 점검과 변경
//
//   node supabase/local/privacy-dates.mjs                        점검(배포 전에 실행). 배포하면 안 되는 상태면 종료 코드 1
//   node supabase/local/privacy-dates.mjs set 2026-10-05 2026-10-12   공고일·시행일을 네 곳에 한 번에 적는다
//   node supabase/local/privacy-dates.mjs set 2026-10-05              예고 없이 그날 개정·시행으로 적는다
//   node supabase/local/privacy-dates.mjs notice                 운영 중인 방침 맨 앞에 붙일 개정 예고문을 출력한다
//
// 날짜가 들어가는 곳(네 곳): 상단 시행일, 제11조 첫 문장, 제11조 개정 이력의 마지막 줄, 맨 아래 줄.
// 처리방침 제11조는 「시행 7일 전부터 웹사이트를 통해 알립니다」라고 적고 있다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'privacy.html');
const KO = /(\d{4})년 (\d{1,2})월 (\d{1,2})일/;
const ko = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${y}년 ${m}월 ${d}일`; };
const iso = (text) => { const m = KO.exec(text || ''); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()); // 한국 날짜(YYYY-MM-DD)

const SPOTS = {
  hero: /(<p class="hero-sub">시행일 )(\d{4}년 \d{1,2}월 \d{1,2}일)(<\/p>)/,
  art11: /(<p>이 개인정보 처리방침은 )(\d{4}년 \d{1,2}월 \d{1,2}일)(부터 적용됩니다\.)/,
  history: /(<li>)(\d{4}년 \d{1,2}월 \d{1,2}일 공고, \d{4}년 \d{1,2}월 \d{1,2}일 시행|\d{4}년 \d{1,2}월 \d{1,2}일 개정·시행)(\s*<ul>)/,
  meta: /(사업자등록번호 849-37-01282 · 시행일 )(\d{4}년 \d{1,2}월 \d{1,2}일)(<\/p>)/,
};

function read() {
  const html = fs.readFileSync(FILE, 'utf8');
  const found = {};
  for (const [k, re] of Object.entries(SPOTS)) {
    const m = re.exec(html);
    if (!m) throw new Error(`privacy.html 에서 날짜 자리(${k})를 찾지 못했습니다. 문서 구조가 바뀌었는지 확인해 주세요.`);
    found[k] = m[2];
  }
  const h = found.history;
  const two = /공고, /.test(h);
  return {
    html,
    notice: iso(h),                                   // 공고일(예고 없이 개정·시행이면 시행일과 같다)
    effective: iso(two ? h.split('공고, ')[1] : h),
    spots: { hero: iso(found.hero), art11: iso(found.art11), meta: iso(found.meta) },
    hasPreview: /개정 예고/.test(html),
  };
}

const NOTICE = (n, e) => `<p><b>개정 예고 (${ko(n)})</b> ${ko(e)}부터 회원가입과 목표 대학 입시 정보 알림 신청 때 휴대전화 번호를 받고, 마케팅 정보 수신 방법에 문자가 추가됩니다. 휴대전화 번호는 회원 식별, 공지 전달과 문의 응대, 회원이 신청한 입시 정보 알림 발송과 회원이 신청한 상담에 관한 연락에 쓰며, 광고성 정보는 수신에 동의한 회원에게만 보냅니다.</p>`;

const [cmd, a, b] = process.argv.slice(2);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

if (cmd === 'set') {
  if (!ISO.test(a || '') || (b && !ISO.test(b))) { console.error('사용법: set <공고일 YYYY-MM-DD> [시행일 YYYY-MM-DD]'); process.exit(2); }
  const n = a, e = b || a;
  if (days(n, e) < 0) { console.error('시행일이 공고일보다 앞설 수 없습니다.'); process.exit(2); }
  let { html } = read();
  html = html.replace(SPOTS.hero, `$1${ko(e)}$3`).replace(SPOTS.art11, `$1${ko(e)}$3`).replace(SPOTS.meta, `$1${ko(e)}$3`)
    .replace(SPOTS.history, `$1${n === e ? `${ko(e)} 개정·시행` : `${ko(n)} 공고, ${ko(e)} 시행`}$3`);
  fs.writeFileSync(FILE, html);
  console.log(`privacy.html 네 곳을 고쳤습니다: 공고 ${ko(n)}, 시행 ${ko(e)}`);
  if (n !== e && days(n, e) < 7) console.log('주의: 공고일과 시행일 사이가 7일보다 짧습니다(제11조 「시행 7일 전부터 알립니다」).');
} else if (cmd === 'notice') {
  const cur = read();
  const n = ISO.test(a || '') ? a : cur.notice, e = ISO.test(b || '') ? b : cur.effective;
  console.log('운영 중인 privacy.html 의 <main class="page legal" id="main"> 바로 다음 줄에 아래 한 문단을 넣어 올립니다.\n');
  console.log(NOTICE(n, e));
} else {
  const cur = read();
  const problems = [];
  const same = Object.values(cur.spots).every((d) => d === cur.effective);
  console.log(`공고일 ${ko(cur.notice)} · 시행일 ${ko(cur.effective)} · 오늘 ${ko(today)}`);
  if (!same) problems.push(`시행일이 자리마다 다릅니다: 상단 ${cur.spots.hero}, 제11조 ${cur.spots.art11}, 개정 이력 ${cur.effective}, 맨 아래 ${cur.spots.meta}`);
  if (days(today, cur.effective) > 0) problems.push(`시행일(${ko(cur.effective)}) 전입니다. 지금 배포하면 적어 둔 시행일보다 먼저 휴대전화 번호 수집이 시작되고, 지금 효력이 있는 방침이 사이트에서 사라집니다. 시행일 이후에 배포하거나 날짜를 고쳐 주세요.`);
  if (cur.hasPreview) problems.push('「개정 예고」 문단이 남아 있습니다. 개정된 방침에서는 지우고 개정 이력으로 대신합니다.');
  if (cur.notice !== cur.effective && days(cur.notice, cur.effective) < 7) problems.push('공고일과 시행일 사이가 7일보다 짧습니다(제11조 「시행 7일 전부터 알립니다」).');
  if (problems.length) {
    console.log('\n배포하지 않습니다.');
    problems.forEach((p) => console.log(' - ' + p));
    console.log('\n확인할 것: 공고일에 실제로 개정 예고문을 운영 사이트에 올렸는지(올린 날이 다르면 set 으로 날짜를 고친다).');
    process.exit(1);
  }
  console.log('날짜 네 곳이 서로 맞고 시행일이 지났습니다.');
  console.log(cur.notice === cur.effective
    ? '예고 없이 개정·시행으로 적혀 있습니다. 배포일이 이 날짜와 같은지 확인해 주세요.'
    : `확인할 것: ${ko(cur.notice)}에 실제로 개정 예고문을 운영 사이트에 올렸는지. 올린 날이 다르면 set 으로 날짜를 고쳐 주세요.`);
}
