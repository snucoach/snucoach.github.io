// 개인정보처리방침(privacy.html)과 이용약관(terms.html)의 공고일·시행일 점검과 변경
//
//   node supabase/local/privacy-dates.mjs                        점검(배포 전에 실행). 배포하면 안 되는 상태면 종료 코드 1
//   node supabase/local/privacy-dates.mjs set 2026-10-05 2026-10-12   두 문서의 공고일·시행일을 한 번에 적는다
//   node supabase/local/privacy-dates.mjs set 2026-10-05              예고 없이 그날 개정·시행으로 적는다
//   node supabase/local/privacy-dates.mjs notice                 운영 중인 두 문서 맨 앞에 붙일 개정 예고문을 출력한다
//
// 날짜가 들어가는 곳
//   처리방침(네 곳): 상단 시행일, 제11조 첫 문장, 제11조 개정 이력의 마지막 항목, 맨 아래 줄
//   이용약관(세 곳): 상단 시행일, 부칙 첫 문장, 부칙 개정 이력의 마지막 항목
// 처리방침 제11조와 약관 제3조는 「시행 7일 전부터(회원에게 불리한 내용이면 30일 전부터) 알린다」고 적고 있다.
// 두 문서는 같은 개정(2026년 10월 회원 후기)으로 함께 바뀌므로 공고일·시행일이 서로 같아야 한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATE = String.raw`\d{4}년 \d{1,2}월 \d{1,2}일`;
const KO = /(\d{4})년 (\d{1,2})월 (\d{1,2})일/;
const ko = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${y}년 ${m}월 ${d}일`; };
const iso = (text) => { const m = KO.exec(text || ''); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()); // 한국 날짜(YYYY-MM-DD)

// 개정 이력 항목: 「…일 공고, …일 시행」 또는 「…일 개정·시행」 뒤에 바뀐 내용 목록(<ul>)이 따른다.
// 이전 문서 링크가 붙은 지난 항목은 건너뛰고, 문서에서 마지막에 나오는 항목(이번 개정)을 읽고 고친다.
const HISTORY = new RegExp(`(<li>)(${DATE} 공고, ${DATE} 시행|${DATE} 개정·시행)(\\s*<ul>)`, 'g');
const DOCS = [
  {
    name: '개인정보처리방침', file: 'privacy.html', count: '네',
    spots: {
      hero: new RegExp(`(<p class="hero-sub">시행일 )(${DATE})(</p>)`),
      first: new RegExp(`(<p>이 개인정보 처리방침은 )(${DATE})(부터 적용됩니다\\.)`),
      meta: new RegExp(`(사업자등록번호 849-37-01282 · 시행일 )(${DATE})(</p>)`),
    },
    labels: { hero: '상단', first: '제11조', meta: '맨 아래' },
  },
  {
    name: '이용약관', file: 'terms.html', count: '세',
    spots: {
      hero: new RegExp(`(<p class="hero-sub">시행일 )(${DATE})(</p>)`),
      first: new RegExp(`(<p>이 약관은 )(${DATE})(부터 시행합니다\\.</p>)`),
    },
    labels: { hero: '상단', first: '부칙' },
  },
];

function lastHistory(html, doc) {
  const all = [...html.matchAll(HISTORY)];
  if (!all.length) throw new Error(`${doc.file} 에서 개정 이력의 날짜 자리를 찾지 못했습니다. 문서 구조가 바뀌었는지 확인해 주세요.`);
  return all[all.length - 1];
}
function read(doc) {
  const html = fs.readFileSync(path.join(ROOT, doc.file), 'utf8');
  const found = {};
  for (const [k, re] of Object.entries(doc.spots)) {
    const m = re.exec(html);
    if (!m) throw new Error(`${doc.file} 에서 날짜 자리(${k})를 찾지 못했습니다. 문서 구조가 바뀌었는지 확인해 주세요.`);
    found[k] = iso(m[2]);
  }
  const h = lastHistory(html, doc)[2];
  const two = /공고, /.test(h);
  return {
    html,
    notice: iso(h),                                   // 공고일(예고 없이 개정·시행이면 시행일과 같다)
    effective: iso(two ? h.split('공고, ')[1] : h),
    spots: found,
    hasPreview: /개정 예고/.test(html),
  };
}

const NOTICES = {
  'terms.html': (n, e) => `<p><b>개정 예고 (${ko(n)})</b> ${ko(e)}부터 후기 페이지에서 회원이 직접 후기를 남길 수 있게 되어, 제10조(회원 후기)를 새로 둡니다. 후기를 쓸 수 있는 사람과 공개 범위(작성자는 이름의 첫 글자만 표시), 저작권과 이용 범위, 올릴 수 없는 후기의 기준과 숨김 처리, 숨김 통지와 이의 제기 방법, 권리 침해 신고, 수강 확인 표시를 정합니다. 기존 제10조~제12조는 제11조~제13조가 됩니다.</p>`,
  'privacy.html': (n, e) => `<p><b>개정 예고 (${ko(n)})</b> ${ko(e)}부터 회원이 후기를 쓰면 후기 내용, 별점, 이용한 프로그램, 작성·수정 일시를 처리합니다. 후기는 후기 페이지에 공개되며 작성자는 이름의 첫 글자만 표시합니다. 후기는 작성자가 지우거나 탈퇴하면 삭제하고, 숨김·수강 확인을 처리한 기록은 작성자를 알 수 있는 정보와 후기 내용을 뺀 채 3년 동안 보관합니다.</p>`,
};

const [cmd, a, b] = process.argv.slice(2);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

if (cmd === 'set') {
  if (!ISO.test(a || '') || (b && !ISO.test(b))) { console.error('사용법: set <공고일 YYYY-MM-DD> [시행일 YYYY-MM-DD]'); process.exit(2); }
  const n = a, e = b || a;
  if (days(n, e) < 0) { console.error('시행일이 공고일보다 앞설 수 없습니다.'); process.exit(2); }
  for (const doc of DOCS) {
    let { html } = read(doc);
    for (const re of Object.values(doc.spots)) html = html.replace(re, `$1${ko(e)}$3`);
    const m = lastHistory(html, doc);
    const line = `${m[1]}${n === e ? `${ko(e)} 개정·시행` : `${ko(n)} 공고, ${ko(e)} 시행`}${m[3]}`;
    html = html.slice(0, m.index) + line + html.slice(m.index + m[0].length);
    fs.writeFileSync(path.join(ROOT, doc.file), html);
    console.log(`${doc.file} ${doc.count} 곳을 고쳤습니다: 공고 ${ko(n)}, 시행 ${ko(e)}`);
  }
  if (n !== e && days(n, e) < 7) console.log('주의: 공고일과 시행일 사이가 7일보다 짧습니다(처리방침 제11조·약관 제3조 「시행 7일 전부터 알립니다」).');
  console.log('sitemap.xml 의 terms.html·privacy.html·reviews.html 날짜(lastmod)도 배포일로 맞춰 주세요.');
} else if (cmd === 'notice') {
  for (const doc of DOCS) {
    const cur = read(doc);
    const n = ISO.test(a || '') ? a : cur.notice, e = ISO.test(b || '') ? b : cur.effective;
    console.log(`운영 중인 ${doc.file} 의 <main class="page legal" id="main"> 바로 다음 줄에 아래 한 문단을 넣어 올립니다.\n`);
    console.log(NOTICES[doc.file](n, e) + '\n');
  }
  console.log('예고문을 운영 사이트에 올린 날이 공고일입니다. 그날이 적어 둔 공고일과 다르면 set 으로 고쳐 주세요.');
} else {
  const problems = [];
  const seen = [];
  for (const doc of DOCS) {
    const cur = read(doc);
    seen.push(cur);
    console.log(`${doc.name}: 공고일 ${ko(cur.notice)} · 시행일 ${ko(cur.effective)}`);
    const same = Object.values(cur.spots).every((d) => d === cur.effective);
    if (!same) problems.push(`${doc.name}의 시행일이 자리마다 다릅니다: ${Object.entries(cur.spots).map(([k, d]) => `${doc.labels[k]} ${d}`).join(', ')}, 개정 이력 ${cur.effective}`);
    if (days(today, cur.effective) > 0) problems.push(`${doc.name}의 시행일(${ko(cur.effective)}) 전입니다. 지금 배포하면 적어 둔 시행일보다 먼저 개정 내용이 시작되고, 지금 효력이 있는 문서가 사이트에서 사라집니다. 시행일 이후에 배포하거나 날짜를 고쳐 주세요.`);
    if (cur.hasPreview) problems.push(`${doc.name}에 「개정 예고」 문단이 남아 있습니다. 개정된 문서에서는 지우고 개정 이력으로 대신합니다.`);
    if (cur.notice !== cur.effective && days(cur.notice, cur.effective) < 7) problems.push(`${doc.name}의 공고일과 시행일 사이가 7일보다 짧습니다(「시행 7일 전부터 알립니다」).`);
  }
  console.log(`오늘 ${ko(today)}`);
  if (seen[0].notice !== seen[1].notice || seen[0].effective !== seen[1].effective) problems.push('처리방침과 약관의 공고일·시행일이 서로 다릅니다. 같은 개정이므로 set 으로 맞춰 주세요.');
  if (problems.length) {
    console.log('\n배포하지 않습니다.');
    problems.forEach((p) => console.log(' - ' + p));
    console.log('\n확인할 것: 공고일에 실제로 개정 예고문을 운영 사이트에 올렸는지(올린 날이 다르면 set 으로 날짜를 고친다).');
    process.exit(1);
  }
  console.log('두 문서의 날짜가 서로 맞고 시행일이 지났습니다.');
  console.log(seen[0].notice === seen[0].effective
    ? '예고 없이 개정·시행으로 적혀 있습니다. 배포일이 이 날짜와 같은지 확인해 주세요.'
    : `확인할 것: ${ko(seen[0].notice)}에 실제로 개정 예고문을 운영 사이트에 올렸는지. 올린 날이 다르면 set 으로 날짜를 고쳐 주세요.`);
}
