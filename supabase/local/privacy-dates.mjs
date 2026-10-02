// 개인정보처리방침(privacy.html)과 이용약관(terms.html)의 공고일·시행일 점검과 변경, 배포 전 점검
//
//   node supabase/local/privacy-dates.mjs                        점검(배포 전에 실행). 배포하면 안 되는 상태면 종료 코드 1
//   node supabase/local/privacy-dates.mjs set 2026-10-05 2026-10-13   두 문서의 공고일·시행일을 한 번에 적는다
//   node supabase/local/privacy-dates.mjs set 2026-10-05              예고 없이 그날 개정·시행으로 적는다
//   node supabase/local/privacy-dates.mjs notice                 운영 중인 두 문서 맨 앞에 붙일 개정 예고문을 출력한다
//   node supabase/local/privacy-dates.mjs preview <폴더>         개정안 전문(terms-next.html · privacy-next.html)을 그 폴더에 만든다.
//                                                                예고문과 함께 운영 사이트에 올려, 회원이 시행 전에 전문을 볼 수 있게 한다
//   node supabase/local/privacy-dates.mjs live                   운영 사이트를 읽어 예고문과 개정안 전문이 실제로 올라가 있는지 확인한다(읽기만)
//   node supabase/local/privacy-dates.mjs curation-ok            후기 페이지의 「후기 모음 안내」 문구를 대표가 확인했다고 표시한다
//
// 날짜가 들어가는 곳
//   처리방침(네 곳): 상단 시행일, 제11조 첫 문장, 제11조 개정 이력의 마지막 항목, 맨 아래 줄
//   이용약관(세 곳): 상단 시행일, 부칙 첫 문장, 부칙 개정 이력의 마지막 항목
// 처리방침 제11조와 약관 제3조는 「시행 7일 전부터(회원에게 불리한 내용이면 30일 전부터) 알린다」고 적고 있다.
// 기간을 셀 때 첫날을 빼면 「7일 전」에 하루가 모자랄 수 있으므로, 공고일과 시행일 사이를 8일 이상 두게 한다(MIN_DAYS).
// 두 문서는 같은 개정(2026년 10월 회원 후기)으로 함께 바뀌므로 공고일·시행일이 서로 같아야 한다.
//
// 그 밖에 점검하는 것
//   - 후기 페이지(reviews.html)의 「후기 모음 안내」 문구를 대표가 확인했는지(data-owner-check="pending" 이 남아 있으면 배포하지 않는다)
//   - 개정안 미리보기 파일(terms-next.html · privacy-next.html)이 저장소에 남아 있지 않은지
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATE = String.raw`\d{4}년 \d{1,2}월 \d{1,2}일`;
const KO = /(\d{4})년 (\d{1,2})월 (\d{1,2})일/;
const ko = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${y}년 ${m}월 ${d}일`; };
const iso = (text) => { const m = KO.exec(text || ''); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()); // 한국 날짜(YYYY-MM-DD)
const MIN_DAYS = 8;                       // 공고일과 시행일 사이(첫날을 빼고 세어도 7일이 되게)
const LIVE = 'https://snucoach.github.io';
const PENDING = / data-owner-check="pending"/;
const PREVIEW = { 'terms.html': 'terms-next.html', 'privacy.html': 'privacy-next.html' };

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

// 예고문: 무엇이 바뀌는지와 개정안 전문 링크. 운영 중인 문서의 <main> 바로 다음 줄에 넣는다.
const NOTICES = {
  'terms.html': (n, e) => `<p><b>개정 예고 (${ko(n)})</b> ${ko(e)}부터 후기 페이지에서 회원이 직접 후기를 남길 수 있게 되어 약관을 고칩니다. ① 제6조: 탈퇴하면 회원이 쓴 후기도 함께 삭제됩니다. ② 제10조(회원 후기) 신설: 후기를 쓸 수 있는 사람과 공개 범위(작성자는 이름의 첫 글자만 표시), 저작권과 이용 범위, 올릴 수 없는 후기의 기준과 숨김 처리, 숨김 통지와 이의 제기 방법, 권리 침해 신고와 임시 조치(30일 이내), 수강 확인 표시, 운영 기준을 되풀이해 위반한 회원의 작성 제한과 숨김 처리된 후기를 지운 뒤의 새 후기 보류(14일), 숨김·수강 확인 처리 기록의 보관(3년). ③ 기존 제10조~제12조는 제11조~제13조가 됩니다(내용 같음). 개정안 전문은 <a href="${PREVIEW['terms.html']}">이용약관 개정안</a>에서 볼 수 있습니다. 개정에 동의하지 않으면 시행일 전에 탈퇴할 수 있습니다.</p>`,
  'privacy.html': (n, e) => `<p><b>개정 예고 (${ko(n)})</b> ${ko(e)}부터 회원이 후기를 쓰면 다음과 같이 개인정보를 처리합니다. ① 처리 항목: 후기 내용, 별점, 이용한 프로그램, 작성·수정 일시, 하루 작성·수정 횟수, 수강 확인 여부, 숨김 처리 기록, 작성 제한 여부와 사유, 숨김 처리된 후기를 지운 뒤의 새 후기 보류 기한. ② 공개 범위: 후기는 후기 페이지에 공개되며 작성자는 이름의 첫 글자만 표시합니다. ③ 수강 확인 표시를 붙일 때와 숨김 처리를 알릴 때 회원의 이름과 이메일을 씁니다. 숨김 처리 안내 메일은 Gmail(Google LLC)로 보냅니다. ④ 보관: 후기는 작성자가 지우거나 탈퇴하면 삭제하고, 숨김·수강 확인을 처리한 기록은 작성자를 알 수 있는 정보와 후기 본문을 뺀 채 3년 동안 보관합니다. 개정안 전문은 <a href="${PREVIEW['privacy.html']}">개인정보처리방침 개정안</a>에서 볼 수 있습니다.</p>`,
};

// 개정안 전문(미리보기): 지금의 문서를 「개정안」 표시와 검색 제외를 붙여 다른 이름으로 만든다.
// 운영 사이트에는 아직 없는 이전 문서로 가는 링크는 뺀다(올리면 깨진 링크가 된다).
function onLive(file) {
  try { execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `origin/main:${file}`], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
function preview(doc, e) {
  const out = PREVIEW[doc.file];
  const label = doc.file === 'terms.html' ? '이용약관' : '개인정보처리방침';
  const swap = (html, re, to) => { if (!re.test(html)) throw new Error(`${doc.file} 에서 미리보기로 바꿀 자리(${re})를 찾지 못했습니다.`); return html.replace(re, to); };
  let html = fs.readFileSync(path.join(ROOT, doc.file), 'utf8');
  html = swap(html, /<title>[^<]*<\/title>/, `<title>${label} 개정안(${ko(e)} 시행 예정) — 스누코치</title>`);
  html = swap(html, /<meta name="description" content="[^"]*">/, `<meta name="description" content="스누코치 ${label} 개정안(${ko(e)} 시행 예정)입니다.">`);
  html = swap(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${LIVE}/${out}">`);
  html = swap(html, /<meta name="robots" content="[^"]*">/, '<meta name="robots" content="noindex,follow">');
  html = swap(html, /(<h1 class="hero-title">)([^<]*)(<\/h1>)/, '$1$2 (개정안)$3');
  html = swap(html, /(<p class="hero-sub">)시행일 /, '$1시행 예정일 ');
  html = swap(html, /(<main class="page legal" id="main">\n)/, `$1<p><b>${ko(e)}부터 시행할 개정안입니다.</b> 지금 적용되는 ${label === '이용약관' ? '약관' : '방침'}은 <a href="${doc.file}">${label}</a>에서 확인해 주세요.</p>\n`);
  html = html.replace(/ \(<a href="((?:terms|privacy)-\d{8}\.html)">이전 (?:약관|방침) 보기<\/a>\)/g, (m, f) => (onLive(f) ? m : ''));
  return [out, html];
}

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
  if (n !== e && days(n, e) < MIN_DAYS) console.log(`주의: 공고일과 시행일 사이가 ${MIN_DAYS}일보다 짧습니다(처리방침 제11조·약관 제3조 「시행 7일 전부터 알립니다」. 첫날을 빼고 세어도 7일이 되게 ${MIN_DAYS}일 이상 둡니다).`);
  console.log('sitemap.xml 의 terms.html·privacy.html·reviews.html 날짜(lastmod)도 배포일로 맞춰 주세요.');
} else if (cmd === 'notice') {
  for (const doc of DOCS) {
    const cur = read(doc);
    const n = ISO.test(a || '') ? a : cur.notice, e = ISO.test(b || '') ? b : cur.effective;
    console.log(`운영 중인 ${doc.file} 의 <main class="page legal" id="main"> 바로 다음 줄에 아래 한 문단을 넣어 올립니다.\n`);
    console.log(NOTICES[doc.file](n, e) + '\n');
  }
  console.log('예고문이 연결하는 개정안 전문(terms-next.html · privacy-next.html)은 `preview <폴더>` 로 만들어 예고문과 함께 올립니다.');
  console.log('예고문을 운영 사이트에 올린 날이 공고일입니다. 그날이 적어 둔 공고일과 다르면 set 으로 고쳐 주세요. 올린 뒤 `live` 로 확인합니다.');
} else if (cmd === 'preview') {
  if (!a) { console.error('사용법: preview <만들 폴더>  (운영 중인 main 을 내려받은 폴더. 이 브랜치의 폴더에 만들면 배포 전 점검이 막는다)'); process.exit(2); }
  const dir = path.resolve(a);
  if (!fs.existsSync(dir)) { console.error(`폴더가 없습니다: ${dir}`); process.exit(2); }
  for (const doc of DOCS) {
    const [out, html] = preview(doc, read(doc).effective);
    fs.writeFileSync(path.join(dir, out), html);
    console.log(`${path.join(dir, out)} 를 만들었습니다(검색 제외, 「개정안」 표시).`);
  }
  console.log('두 파일을 예고문과 함께 운영 사이트에 올립니다. 개정된 문서를 배포할 때 두 파일은 지웁니다.');
} else if (cmd === 'live') {
  // 운영 사이트를 읽기만 한다(GET). 예고문을 실제로 올렸는지, 개정안 전문이 열리는지 본다.
  let bad = 0;
  for (const doc of DOCS) {
    const cur = read(doc);
    const get = async (file) => { try { const res = await fetch(`${LIVE}/${file}`, { cache: 'no-store' }); return { status: res.status, text: res.ok ? await res.text() : '' }; } catch (e) { return { status: 0, text: '' }; } };
    const page = await get(doc.file);
    const m = /<b>개정 예고 \(([^)]+)\)<\/b>/.exec(page.text);
    const next = await get(PREVIEW[doc.file]);
    const okNotice = !!m && iso(m[1]) === cur.notice && page.text.includes(ko(cur.effective));
    console.log(`${doc.name}: 운영 문서 ${page.status || '연결 실패'} · 예고문 ${m ? `있음(${m[1]})` : '없음'} · 개정안 전문 ${next.status === 200 ? '있음' : `없음(${next.status || '연결 실패'})`}`);
    if (!okNotice) { bad++; console.log(` - 운영 중인 ${doc.file} 에 공고일 ${ko(cur.notice)}·시행일 ${ko(cur.effective)}의 개정 예고문이 없습니다.`); }
    if (next.status !== 200) { bad++; console.log(` - 운영 사이트에 ${PREVIEW[doc.file]} 가 없습니다(예고문의 「개정안 전문」 링크가 깨집니다).`); }
  }
  console.log(bad ? '\n예고가 끝나지 않았습니다. 예고문과 개정안 전문을 올린 날이 공고일입니다.' : '\n운영 사이트에 예고문과 개정안 전문이 올라가 있습니다.');
  process.exit(bad ? 1 : 0);
} else if (cmd === 'curation-ok') {
  const f = path.join(ROOT, 'reviews.html');
  const html = fs.readFileSync(f, 'utf8');
  if (!PENDING.test(html)) { console.log('reviews.html 의 「후기 모음 안내」는 이미 확인된 것으로 표시되어 있습니다.'); process.exit(0); }
  fs.writeFileSync(f, html.replace(PENDING, ''));
  console.log('reviews.html 의 「후기 모음 안내」(#rvAbout)를 대표가 확인한 것으로 표시했습니다(data-owner-check 를 지웠습니다).');
  console.log('생성기(_site_build/render_site.py 의 CURATED_ABOUT)에도 같은 표시가 있으면 함께 지워 주세요.');
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
    if (cur.notice !== cur.effective && days(cur.notice, cur.effective) < MIN_DAYS) problems.push(`${doc.name}의 공고일과 시행일 사이가 ${MIN_DAYS}일보다 짧습니다(「시행 7일 전부터 알립니다」. 첫날을 빼고 세어도 7일이 되게 ${MIN_DAYS}일 이상 둡니다).`);
    if (fs.existsSync(path.join(ROOT, PREVIEW[doc.file]))) problems.push(`개정안 미리보기 파일 ${PREVIEW[doc.file]} 가 남아 있습니다. 개정된 문서를 배포할 때는 지웁니다.`);
  }
  // 후기 페이지 위쪽 「후기 모음 안내」: 받은 경로·골라 싣는 기준·게시 기간·게시 동의는 사실관계라 대표가 확인한 뒤에 내보낸다
  if (PENDING.test(fs.readFileSync(path.join(ROOT, 'reviews.html'), 'utf8'))) {
    problems.push('후기 페이지의 「후기 모음 안내」(reviews.html 의 #rvAbout) 문구를 대표가 아직 확인하지 않았습니다. 문구가 사실과 맞는지 확인하고(다르면 고친 뒤) `node supabase/local/privacy-dates.mjs curation-ok` 를 실행해 주세요.');
  }
  console.log(`오늘 ${ko(today)}`);
  if (seen[0].notice !== seen[1].notice || seen[0].effective !== seen[1].effective) problems.push('처리방침과 약관의 공고일·시행일이 서로 다릅니다. 같은 개정이므로 set 으로 맞춰 주세요.');
  if (problems.length) {
    console.log('\n배포하지 않습니다.');
    problems.forEach((p) => console.log(' - ' + p));
    console.log('\n확인할 것: 공고일에 실제로 개정 예고문과 개정안 전문을 운영 사이트에 올렸는지(`live` 로 확인. 올린 날이 다르면 set 으로 날짜를 고친다).');
    process.exit(1);
  }
  console.log('두 문서의 날짜가 서로 맞고 시행일이 지났습니다.');
  console.log(seen[0].notice === seen[0].effective
    ? '예고 없이 개정·시행으로 적혀 있습니다. 배포일이 이 날짜와 같은지 확인해 주세요.'
    : `확인할 것: ${ko(seen[0].notice)}에 실제로 개정 예고문과 개정안 전문을 운영 사이트에 올렸는지. 올린 날이 다르면 set 으로 날짜를 고쳐 주세요.`);
}
