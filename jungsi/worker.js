// 배치 계산 워커: 원본 엑셀 수식(model.json)을 xlcalc로 그대로 평가한다.
// 합격선: data/lines.json 이 있는 학과는 군 시트 R~V열(90·70·40·10·3% 기준점)을 새 기준점으로 바꿔 넣고 엑셀 AD·P 수식으로 판정한다.
// data/extra.json 모집단위(원본 배치표에 없는 곳)는 아래 judgeExtra 로 판정한다. 데이터 형식은 엔진 폴더의 INTEGRATION_CONTRACT.md
importScripts("xlcalc.js");
const DATA_V = "20260930e"; // lines.json·extra.json 을 바꾸면 올림(브라우저 캐시)
let MODEL = null, DEPTS = null, LINES = null, EXTRA = null, SHEET = {};
let LSET = [], XU = [], LOK = []; // LSET: [시트, [R..V 주소], 기준점 5개], XU: extra 모집단위(빌릴 학과 번호 붙임), LOK: 학과별 새 기준점 사용 여부
const AST = new Map(); // 시나리오마다 새 워크북을 만들되 수식 파싱 결과는 공유
const optJSON = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null); // 새 합격선 파일이 없으면 원본 기준점으로 동작
const ready = Promise.all([
  fetch("data/model.json").then((r) => r.json()),
  fetch("data/depts.json").then((r) => r.json()),
  optJSON("data/lines.json?v=" + DATA_V),
  optJSON("data/extra.json?v=" + DATA_V),
]).then(([m, d, ln, ex]) => {
  MODEL = m; DEPTS = d; LINES = ln && ln.d ? ln : null; EXTRA = ex && ex.units ? ex : null;
  for (const n of Object.keys(m.sheets)) SHEET[n.trim()] = n;
  prep();
  postMessage({ type: "ready", lines: LSET.length, extra: XU.length });
}).catch((e) => postMessage({ type: "error", message: String(e) }));

// ── '본인점수 입력' 48~53행을 2026 수능 값으로 바꿈 ──
// 원자료 48행=과목 이름, 49행=만점표점(AA49 라벨 '25수능'), 52행=탐구 과목 약칭, 53행=응시인원(X53 라벨 '25수능').
// 표준점수 기준(E4=1)에서 32행 최고표점=49행 → 17행 AE~AK(국어 MAX(B:C), 수학 MAX(D:F), 탐구는 과목별) → 환산공식 G12~M12,
// Z53=X49(과탐 가중최고점)·AA53=Y49(사탐 가중최고점) → 환산공식 AF7~AJ7·AS9~AW9. 표점/만점으로 반영하는 대학(한양·이화·시립·숙명 등)의 분모.
// 원자료는 25수능 값이라, 웹이 넣는 2026 표준점수가 만점표점을 넘는 경우가 생김(예: 언매 147 > 139).
// 근거: engine/suneung2026/kice2026.json(평가원 2026 수능 표준점수 도수분포·보도자료 표Ⅰ-3), web/data/conv2026.json
//  - 탐구 17과목 최고점 = 평가원 도수분포 최고점(공식) = conv2026 원점수 50점의 표준점수(17과목 모두 같음)
//  - 국어·수학 선택과목별 최고점(B~F)은 평가원이 발표하지 않음: conv2026(크럭스 공식) 원점수 100점의 표준점수 = 추정값.
//    다만 엑셀은 국어 MAX(B,C)·수학 MAX(D,E,F)만 쓰므로 실제로 쓰이는 값은 147·139 = 평가원 공식 영역 최고점과 같음
//  - 응시인원(53행) = 평가원 보도자료 표Ⅰ-3(공식). X49·Y49·Z49 = 과목별 최고점을 응시인원으로 가중평균, 소수 셋째 자리 반올림(원자료와 같은 방식)
const MAX_STD_2026 = { B: 147, C: 142, D: 139, E: 139, F: 137, // 언매·화작·미적·기하·확통(추정, 위 설명)
  G: 70, H: 71, I: 74, J: 68, K: 68, L: 70, M: 69, N: 69, // 물리Ⅰ·화학Ⅰ·생명과학Ⅰ·지구과학Ⅰ·물리Ⅱ·화학Ⅱ·생명과학Ⅱ·지구과학Ⅱ
  O: 71, P: 70, Q: 72, R: 73, S: 68, T: 72, U: 70, V: 67, W: 70 }; // 생윤·윤사·한지·세지·동아시아사·세계사·경제·정법·사문
const TAKERS_2026 = { G: 42232, H: 23321, I: 102836, J: 106729, K: 5236, L: 5242, M: 7279, N: 4264,
  O: 196382, P: 46145, Q: 42518, R: 41655, S: 20507, T: 19884, U: 7085, V: 33123, W: 239403 };
const INPUT_2026 = (() => {
  const o = {}, wavg = (cs) => Math.round((cs.reduce((s, c) => s + MAX_STD_2026[c] * TAKERS_2026[c], 0) / cs.reduce((s, c) => s + TAKERS_2026[c], 0)) * 1000) / 1000;
  for (const [c, v] of Object.entries(MAX_STD_2026)) o[c + "49"] = v;
  for (const [c, v] of Object.entries(TAKERS_2026)) o[c + "53"] = v;
  const sci = "GHIJKLMN".split(""), soc = "OPQRSTUVW".split("");
  o.X49 = wavg(sci); o.Y49 = wavg(soc); o.Z49 = wavg([...sci, ...soc]); // 70.67 · 70.473 · 70.535 (원자료 25수능 69.823 · 71.561 · 70.789)
  return o;
})();

// 새 기준점·extra 준비(한 번만)
const R5 = ["R", "S", "T", "U", "V"];
function prep() {
  LSET = []; LOK = new Array(DEPTS.length).fill(0);
  const kIdx = new Map();
  DEPTS.forEach((d, i) => {
    kIdx.set(d.k, i);
    const x = LINES && LINES.d[d.k];
    if (!x || !Array.isArray(x.t) || x.t.length !== 5) return;
    LSET.push([SHEET[d.s.trim()], R5.map((c) => c + d.r), x.t]); LOK[i] = x.o ? 2 : 1; // 1 = 새 기준점, 2 = 새 기준점(공식 자료 밖 수준 → 참고)
  });
  XU = EXTRA ? EXTRA.units.map((u) => (u.m === "b" ? { ...u, qi: kIdx.has(u.q) ? kIdx.get(u.q) : -1 } : u)) : [];
}

// 입력 셀(표준점수 기준): 국어 B/C, 수학 D/E/F, 과탐 G~N, 사탐 O~W (22 표준점수·23 백분위·24 등급), 영어·한국사·제2외 B/C/D27 등급
// withLines=false 면 원본 기준점 그대로(점수 변환만 할 때)
function makeWB(cells, withLines = true) {
  const wb = new XLCalc.Workbook(MODEL, AST);
  wb.setInput(SHEET["배치점수 계산기"], "E4", 1); // 표준점수 기준(원점수는 화면에서 2026 수능 기준 표준점수·백분위로 바꿔 넣음)
  for (const [a, v] of Object.entries(INPUT_2026)) wb.setInput(SHEET["본인점수 입력"], a, v);
  for (const [a, v] of Object.entries(cells)) wb.setInput(SHEET["본인점수 입력"], a, v);
  if (withLines) for (const [sh, as, t] of LSET) for (let j = 0; j < 5; j++) wb.setInput(sh, as[j], t[j]);
  return wb;
}
const val = (v) => (v === null || v === undefined || v === "" || XLCalc.isErr(v) ? null : v);

function conversions(wb, cells) {
  const S = SHEET["본인점수 입력"], out = {};
  for (const a of Object.keys(cells)) {
    const col = a.replace(/\d+/g, ""), row = +a.replace(/\D+/g, "");
    if (row === 8) out[a] = { std: val(wb.get(S, col + "9")), pct: val(wb.get(S, col + "10")), grade: val(wb.get(S, col + "11")) };
    if (row === 14) out[a] = { grade: val(wb.get(S, col + "17")) };
  }
  return out;
}

// 학과 판정(depts 순). ref=1: 화면에서 네 단계(적정·소신·상향·어려움)+'참고'로 보일 행(원본 기준점 그대로이거나 공식 자료 밖 수준)
function placement(wb) {
  const res = new Array(DEPTS.length);
  for (let i = 0; i < DEPTS.length; i++) {
    const d = DEPTS[i], sh = SHEET[d.s.trim()], r = d.r;
    let ok, q, ad, p;
    try {
      ok = wb.get(sh, "L" + r); q = wb.get(sh, "Q" + r); ad = wb.get(sh, "AD" + r); p = wb.get(sh, "P" + r);
    } catch (e) { res[i] = null; continue; }
    // 엑셀이 내 환산점수를 못 구한 행(Q가 숫자가 아님)은 판정에서 제외 — 원본은 이 경우 '안정'으로 잘못 표시됨
    if (typeof q !== "number") { res[i] = { x: 1 }; continue; }
    res[i] = { ok: ok === "O", q, ad: typeof ad === "number" ? ad : null, p: val(p), ref: LOK[i] === 1 ? 0 : 1 };
  }
  return res;
}

// ── extra 모집단위 판정 (원자료 AD·P 수식과 같은 분기) ──
function adOf(v, th, ok) {
  if (!ok) return 6;
  return v > th[0] ? 1 : v > th[1] ? 2 : v > th[2] ? 3 : v > th[3] ? 4 : v >= th[4] ? 5 : 6;
}
function pOf(v, th) {
  const [R, S, T, U, V] = th, rd = Math.round;
  if (v > R) return "90% 이상";
  if (v > S) return rd(((v - S) / (R - S)) * 20 + 70) + "%";
  if (v > T) return rd(((v - T) / (S - T)) * 30 + 40) + "%";
  if (v > U) return rd(((v - U) / (T - U)) * 30 + 10) + "%";
  if (v > V) return rd(((v - V) / (U - V)) * 7 + 3) + "%";
  return "3% 이하";
}
// 학생 백분위·등급(입력 셀 23행·27행): 국어 B/C, 수학 D/E/F, 탐구 G~W 중 넣은 두 과목
const TAM = "GHIJKLMNOPQRSTUVW".split("");
function student(cells) {
  const g = (c) => (typeof cells[c + "23"] === "number" ? cells[c + "23"] : null);
  const tc = TAM.filter((c) => g(c) != null), t = tc.map(g);
  return { kor: g("B") ?? g("C"), math: g("D") ?? g("E") ?? g("F"), t1: t.length ? t[0] : null, t2: t.length > 1 ? t[1] : t.length ? t[0] : null,
    sci: tc.length >= 2 && tc.every((c) => c <= "N"), eng: cells.B27 || 2, hist: cells.C27 || 2 };
}
// 기준영역 평균 백분위: parts = [[고를 수, 영역…]], K=국어 M=수학 T2=탐구 두 과목 평균 T1=탐구 높은 한 과목, 고를 수만큼 높은 것부터
function areaAvg(parts, s) {
  const v = { K: s.kor, M: s.math, T2: (s.t1 + s.t2) / 2, T1: Math.max(s.t1, s.t2) };
  let sum = 0, n = 0;
  for (const [c, ...toks] of parts) { const xs = toks.map((t) => v[t]).sort((a, b) => b - a); for (let j = 0; j < c; j++) sum += xs[j]; n += c; }
  return sum / n;
}
// 반환 배열은 extra.json units 순서. b(빌린 수식) = 그 학과 환산점수 Q·응시 조건 L + 새 기준점, p(백분위 비교) = 기준영역 평균 백분위 + 영어·한국사 보정
function judgeExtra(rows, cells) {
  const s = student(cells), hasPct = s.kor != null && s.math != null && s.t1 != null;
  return XU.map((u) => {
    if (u.m === "b") {
      const r = u.qi >= 0 ? rows[u.qi] : null;
      if (!r || r.x) return { x: 1 };
      return { ok: r.ok, q: r.q, ad: adOf(r.q, u.th, r.ok), p: pOf(r.q, u.th), ref: 1 };
    }
    if (!hasPct) return { x: 1 };
    const a = EXTRA.adj[u.t === "자연" ? "N" : "H"][String(u.e)];
    const v = areaAvg(EXTRA.areas[u.a], s) + (a ? a[s.eng - 1] + a[9 + s.hist - 1] : 0);
    const ok = !(u.sc && !s.sci); // sc=1: 과학탐구 두 과목만 지원 가능
    return { ok, v: Math.round(v * 100) / 100, ad: adOf(v, u.th, ok), p: pOf(v, u.th), ref: 1 };
  });
}

onmessage = async (ev) => {
  const msg = ev.data;
  await ready;
  if (!MODEL) return;
  if (msg.type === "convert") {
    const wb = makeWB(msg.cells, false);
    postMessage({ type: "converted", id: msg.id, conv: conversions(wb, msg.cells) });
  } else if (msg.type === "place") {
    const t0 = Date.now();
    const out = {};
    for (const [name, cells] of Object.entries(msg.scenarios)) {
      if (msg.convOnly) { out[name] = { conv: conversions(makeWB(cells, false), cells) }; continue; }
      const wb = makeWB(cells), rows = placement(wb);
      out[name] = { conv: conversions(wb, cells), rows, extra: judgeExtra(rows, cells) };
    }
    postMessage({ type: "placed", id: msg.id, out, depts: msg.wantDepts ? DEPTS : undefined, data: msg.wantDepts ? { lines: LINES, extra: EXTRA } : undefined, ms: Date.now() - t0 });
  }
};
