// 스누코치 정시 배치 계산기 — 화면 로직
// 원점수 → (2026 수능 기준 표준점수·백분위, 학생이 수정 가능) → worker.js가 원본 배치표 엑셀 수식(표준점수 기준 모드)으로 환산하고
// 스누코치가 다시 맞춘 합격선(data/lines.json·data/extra.json)으로 판정 → picks.js가 대학·군·계열 묶음 목록을 만듦
(function () {
  "use strict";
  const FORM = "https://smore.im/form/r7q2TCOBoc";
  const SCI = [["G", "물리Ⅰ", "물리학Ⅰ"], ["H", "화학Ⅰ", "화학Ⅰ"], ["I", "생명과학Ⅰ", "생명과학Ⅰ"], ["J", "지구과학Ⅰ", "지구과학Ⅰ"], ["K", "물리II", "물리학Ⅱ"], ["L", "화학II", "화학Ⅱ"], ["M", "생명과학II", "생명과학Ⅱ"], ["N", "지구과학II", "지구과학Ⅱ"]];
  const SOC = [["O", "생활과윤리", "생활과 윤리"], ["P", "윤리와사상", "윤리와 사상"], ["Q", "한국지리", "한국지리"], ["R", "세계지리", "세계지리"], ["S", "동아시아사", "동아시아사"], ["T", "세계사", "세계사"], ["U", "경제", "경제"], ["V", "정치와법", "정치와 법"], ["W", "사회문화", "사회·문화"]];
  const COLNAME = { B: "언매", C: "화작", D: "미적", E: "기하", F: "확통" }; [...SCI, ...SOC].forEach(([c, n]) => (COLNAME[c] = n));
  // kind: rel = 상대평가(표준점수·백분위), abs = 절대평가(등급만)
  const SUBJ = [
    { key: "kor", name: "국어", opts: [["B", "언매"], ["C", "화작"]], max: 100, kind: "rel" },
    { key: "math", name: "수학", opts: [["D", "미적"], ["E", "기하"], ["F", "확통"]], max: 100, kind: "rel" },
    { key: "eng", name: "영어", col: "B", abs: [90, 80, 70, 60, 50, 40, 30, 20], max: 100, kind: "abs" },
    { key: "hist", name: "한국사", col: "C", abs: [40, 35, 30, 25, 20, 15, 10, 5], max: 50, kind: "abs" },
    { key: "t1", name: "탐구 1", pick: true, max: 50, kind: "rel" },
    { key: "t2", name: "탐구 2", pick: true, max: 50, kind: "rel" },
    { key: "l2", name: "제2외국어·한문", col: "D", abs: [45, 40, 35, 30, 25, 20, 15, 10], max: 50, kind: "abs", optional: true,
      note: "서울대 인문계열(경영대학·간호대학 포함)은 자유전공학부를 빼면 제2외국어·한문 응시가 지원 조건이에요. 응시했거나 응시할 예정이면 넣어 주세요(선택)." },
  ];
  const MAIN = SUBJ.filter((s) => !s.optional);
  const PK = window.JungsiPicks; // picks.js: (대학, 군, 계열) 묶음 → 구간별 대학 목록
  if (!PK || !PK.BANDS) { // picks.js를 못 불러온 경우(옛 캐시 등): 입력 화면까지 멈추지 않게 안내만 하고 끝냄
    const l = document.getElementById("loading"); if (l) l.textContent = "페이지를 새로 불러와 주세요.";
    return;
  }
  const BAND_TXT = {
    up: { label: "상향", desc: "도전해 볼 대학" },
    mid: { label: "소신", desc: "해 볼 만한 대학" },
    safe: { label: "적정", desc: "든든한 대학" },
  };
  const BANDS = PK.BANDS.map((b) => ({ ...b, ...BAND_TXT[b.key] }));
  const MAX_ROWS = 10; // 구간마다 보여 줄 대학 수 상한
  // 의·치·한·약·수 카드 아이콘: 아스클레피오스의 지팡이(색으로만 구분)
  const ROD = '<path d="M12 2.4v19.2" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round"/><path d="M8.9 5.6c1.5-1.5 6.4-1.3 6.4 1.1 0 2.4-6.6 2.4-6.6 5.1 0 2.5 6.8 2.3 6.8 5 0 2.3-5.9 2.1-5.9 3.9" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8.5" cy="5.9" r="1.45" fill="#fff"/>';
  const MEDCOLOR = { 의예: "#E5484D", 치의예: "#0EA5E9", 한의예: "#16A34A", 약학: "#F59E0B", 수의예: "#8B5CF6" };
  const LOAD_MIN = 1600; // 계산 연출 최소 시간(ms)

  const state = { sel: { kor: null, math: null, t1: null, t2: null }, raw: {}, delta: {}, ov: {}, track: "all", trackAuto: true,
    last: null, depts: null, data: null, conv: null, pk: null, pending: false, targets: new Map() };
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const f = (n) => Number(n).toLocaleString("ko-KR");
  const worker = new Worker("worker.js?v=20260930e"); // worker.js·data/lines.json·data/extra.json을 고치면 버전도 올림(브라우저 캐시)
  let reqId = 0, ready = false;

  // ── 2026 수능 기준 변환 ──
  const colOf = (s) => (s.col ? s.col : state.sel[s.key] || null);
  const nameOf = (s) => COLNAME[colOf(s)];
  const empty = (k) => state.raw[k] === undefined || state.raw[k] === "";
  function tab(s, raw) { // 원점수 → [표준점수, 백분위, 등급]
    const t = state.conv && state.conv.subjects[nameOf(s)]; if (!t) return null;
    const v = t.table[String(raw)]; return v ? { std: v[0], pct: v[1], grade: v[2] } : null;
  }
  function s2p(s, std) { // 표준점수 → [백분위, 등급] (평가원 도수분포 기준, 없는 점수는 바로 아래 점수 값)
    const m = state.conv && state.conv.std_to_pct[nameOf(s)]; if (!m) return null;
    if (m[String(std)]) return { pct: m[String(std)][0], grade: m[String(std)][1] };
    const keys = Object.keys(m).map(Number).filter((k) => k <= std).sort((a, b) => b - a);
    return keys.length ? { pct: m[String(keys[0])][0], grade: m[String(keys[0])][1] } : null;
  }
  const absGrade = (s, raw) => { const g = s.abs.findIndex((c) => raw >= c); return g < 0 ? 9 : g + 1; };
  const rawOf = (s) => Math.max(0, Math.min(s.max, Math.round(+state.raw[s.key])));
  // 2026 변환표에 있는 원점수인지(국어·수학 1·99점, 탐구 1·49점은 나올 수 없는 점수라 표에 없음)
  const possible = (s, r) => s.kind !== "rel" || !colOf(s) || !!tab(s, r);
  // r을 나올 수 있는 원점수로 맞춤: dir ≥ 0이면 위(99→100)부터, dir < 0이면 아래(99→98)부터 찾음. 0~만점 밖으로는 안 감
  function snapRaw(s, r, dir) {
    r = Math.max(0, Math.min(s.max, r));
    if (possible(s, r)) return r;
    const up = () => { for (let x = r + 1; x <= s.max; x++) if (possible(s, x)) return x; return null; };
    const dn = () => { for (let x = r - 1; x >= 0; x--) if (possible(s, x)) return x; return null; };
    const v = dir < 0 ? (dn() ?? up()) : (up() ?? dn());
    return v == null ? r : v;
  }
  // 목표 원점수 = 지금 원점수 + 올린 점수. 나올 수 없는 점수(99·49 등)면 가까운 가능한 점수로 맞춰, 목표 계산에서 과목이 빠지지 않게 함
  function goalRaw(s) {
    const raw = rawOf(s), d = s.optional ? 0 : state.delta[s.key] || 0;
    return d > 0 ? Math.max(raw, snapRaw(s, raw + d, 1)) : raw;
  }
  // 목표 원점수를 r 쪽으로 옮김(가능한 점수로 맞춤, 지금 원점수 아래로는 안 감) — 스테퍼·'다음 등급까지'·빠른 버튼 공용
  function setGoal(s, r, dir) {
    const raw = rawOf(s); if (!Number.isFinite(raw)) return;
    state.delta[s.key] = r <= raw ? 0 : Math.max(0, snapRaw(s, r, dir) - raw);
  }
  const roundPct = (p) => (typeof p === "number" ? Math.round(p) : p); // 백분위는 정수로(배치표 변환표준점수 표가 정수 백분위만 있음)
  function scoreOf(s, target) { // {std, pct, grade, src}
    if (empty(s.key)) return null;
    const raw = rawOf(s);
    const r2 = target ? goalRaw(s) : raw, d = r2 - raw;
    if (s.kind === "abs") return { grade: absGrade(s, r2), src: "auto" };
    if (!colOf(s)) return null;
    const base = tab(s, raw), tgt = tab(s, r2), ov = state.ov[s.key] || {};
    if (ov.std == null && ov.pct == null) return tgt ? { ...tgt, src: "auto" } : null;
    // 직접 입력한 값에서 출발: 올린 원점수만큼의 표준점수 변화를 더하고, 백분위·등급은 평가원 도수분포로 다시 찾음
    const std0 = ov.std != null ? ov.std : base && base.std; if (std0 == null) return null;
    // 지금 원점수가 변환표에 없는 점수(직접 입력한 경우)면 바로 아래 가능한 점수를 기준으로 변화량을 셈
    const b0 = base || (d ? tab(s, snapRaw(s, raw, -1)) : null);
    const dStd = b0 && tgt ? tgt.std - b0.std : 0; const std = std0 + dStd;
    let pct, grade; const sp = s2p(s, std);
    if (!d && ov.pct != null) pct = ov.pct; else if (sp) pct = sp.pct; else pct = ov.pct != null ? Math.min(100, ov.pct + (b0 && tgt ? tgt.pct - b0.pct : 0)) : base && base.pct;
    grade = sp ? sp.grade : base && base.grade;
    return { std, pct: roundPct(pct), grade, src: "user" };
  }
  function cellsFor(target) { // 원본 배치표 '표준점수 기준' 입력 칸
    const cells = {};
    for (const s of SUBJ) {
      const v = scoreOf(s, target); if (!v) continue;
      if (s.kind === "abs") cells[s.col + "27"] = v.grade;
      else { const c = colOf(s); cells[c + "22"] = v.std; cells[c + "23"] = v.pct; cells[c + "24"] = v.grade; }
    }
    return cells;
  }

  // ── 입력 화면 ──
  function renderInputs() {
    const box = $("#subjects"); box.innerHTML = "";
    for (const s of SUBJ) {
      let ctl = "";
      if (s.opts) ctl += `<div class="seg" role="group" aria-label="${s.name} 선택과목">${s.opts.map(([c, n]) => `<button type="button" data-k="${s.key}" data-c="${c}" aria-pressed="${state.sel[s.key] === c}">${n}</button>`).join("")}</div>`;
      if (s.pick) ctl += `<select class="subjpick" data-k="${s.key}" aria-label="${s.name} 과목"><option value="" ${state.sel[s.key] ? "" : "selected"} disabled>과목 선택</option><optgroup label="과학탐구">${SCI.map(([c, , l]) => `<option value="${c}" ${state.sel[s.key] === c ? "selected" : ""}>${l}</option>`).join("")}</optgroup><optgroup label="사회탐구">${SOC.map(([c, , l]) => `<option value="${c}" ${state.sel[s.key] === c ? "selected" : ""}>${l}</option>`).join("")}</optgroup></select>`;
      ctl += `<label class="num"><span class="nl">원점수</span><input type="number" inputmode="numeric" min="0" max="${s.max}" step="1" data-k="${s.key}" data-f="raw" placeholder="–" value="${esc(state.raw[s.key] ?? "")}" aria-label="${s.name} 원점수"><small>/ ${s.max}</small></label>`;
      if (s.kind === "rel") ctl += `<div class="ovrow" id="ov-${s.key}"></div>`;
      else ctl += `<div class="conv" id="conv-${s.key}"></div>`;
      if (s.note) ctl += `<div class="conv note">${s.note}</div>`;
      const row = document.createElement("div"); row.className = "subj";
      row.innerHTML = `<div class="name">${s.name}${s.optional ? '<span class="opt">선택</span>' : ""}</div><div class="ctl">${ctl}</div>`;
      box.appendChild(row);
    }
    SUBJ.forEach(renderScore);
  }
  function renderScore(s) { // 원점수 아래: 표준점수·백분위(수정 가능)·등급
    if (s.kind === "abs") { const el = $("#conv-" + s.key); if (el) { const v = scoreOf(s, false); el.innerHTML = v ? `<span class="g">${v.grade}등급</span> <span class="src">절대평가</span>` : ""; } return; }
    const el = $("#ov-" + s.key); if (!el) return;
    const v = scoreOf(s, false), ov = state.ov[s.key] || {};
    if (v) { el.innerHTML = fields(s, v, ov); return; }
    // 원점수가 2026 변환표에 없으면 표준점수·백분위를 직접 받는다
    el.innerHTML = !empty(s.key) && colOf(s) ? `<span class="warn">2026 수능 변환표에 없는 원점수예요. 표준점수·백분위를 직접 넣어 주세요.</span>` + fields(s, {}, ov) : "";
  }
  function fields(s, v, ov) {
    const user = ov.std != null || ov.pct != null;
    return `<label class="mini"><span>표준점수</span><input type="number" inputmode="numeric" data-k="${s.key}" data-f="std" value="${ov.std ?? v.std ?? ""}" class="${ov.std != null ? "edited" : ""}" aria-label="${s.name} 표준점수"></label>
      <label class="mini"><span>백분위</span><input type="number" inputmode="numeric" data-k="${s.key}" data-f="pct" value="${ov.pct ?? v.pct ?? ""}" class="${ov.pct != null ? "edited" : ""}" aria-label="${s.name} 백분위"></label>
      <span class="g">${v.grade ?? "-"}등급</span>
      <span class="src">${user ? `직접 입력 <button type="button" class="reset" data-k="${s.key}">되돌리기</button>` : "2026 수능 기준 자동"}</span>
      <span class="rnote">${pctNote(ov)}</span>`;
  }
  // 직접 넣은 백분위가 소수면 정수로 반올림해 계산한다는 안내(배치표 변환표준점수 표는 정수 백분위만 있음)
  // 0~100 밖이면 반올림 안내 대신 validate()의 범위 오류만 보이게 함
  const pctNote = (ov) => (typeof ov.pct === "number" && Number.isFinite(ov.pct) && !Number.isInteger(ov.pct) && ov.pct >= 0 && ov.pct <= 100 ? `백분위는 정수로 반올림해 계산해요(${ov.pct} → ${Math.round(ov.pct)}).` : "");
  function nextCut(s) { // 다음 등급까지 필요한 원점수(2026 수능 기준)
    if (empty(s.key) || (!colOf(s) && s.kind === "rel")) return null;
    const cur = scoreOf(s, true); if (!cur || cur.grade == null || cur.grade <= 1) return null;
    const base = goalRaw(s);
    for (let r = base + 1; r <= s.max; r++) {
      const g = s.kind === "abs" ? absGrade(s, r) : (tab(s, r) || {}).grade;
      if (g != null && g < cur.grade) return { need: r - base };
    }
    return null;
  }
  function renderGoals() {
    const box = $("#goals"); box.innerHTML = "";
    for (const s of MAIN) {
      const has = !empty(s.key); const r = has ? +state.raw[s.key] : null;
      const to = has ? goalRaw(s) : null; const d = has ? Math.max(0, to - rawOf(s)) || 0 : state.delta[s.key] || 0; const nc = has ? nextCut(s) : null;
      const now = has ? scoreOf(s, false) : null, goal = has ? scoreOf(s, true) : null;
      const gtxt = now && goal && d ? `<div class="conv">${goal.std != null ? `표준점수 ${now.std} → <b>${goal.std}</b> · ` : ""}${now.grade} → <b>${goal.grade}</b>등급</div>` : "";
      const row = document.createElement("div"); row.className = "goal";
      row.innerHTML = `<div class="name">${s.name}</div>
        <div class="from">${has ? `원점수 <b>${r}</b> → <b class="to">${to}</b>` : "원점수를 먼저 넣어 주세요"}${gtxt}${nc ? `<button type="button" class="nextg" data-k="${s.key}" data-n="${nc.need}">다음 등급까지 +${nc.need}점</button>` : ""}</div>
        <div class="stepper"><button type="button" data-k="${s.key}" data-d="-1" aria-label="${s.name} 목표 1점 내리기" ${has ? "" : "disabled"}>−</button><span class="d">+${d}</span><button type="button" data-k="${s.key}" data-d="1" aria-label="${s.name} 목표 1점 올리기" ${has ? "" : "disabled"}>+</button></div>`;
      box.appendChild(row);
    }
  }
  function validate() {
    const unsel = SUBJ.filter((s) => (s.opts || s.pick) && !state.sel[s.key]).map((s) => s.name);
    if (unsel.length) return `${unsel.join("·")} 과목을 골라 주세요.`;
    const need = MAIN.filter((s) => empty(s.key)).map((s) => s.name);
    if (need.length) return `${need.join("·")} 원점수를 넣어 주세요. 배치표는 국어·수학·영어·한국사와 탐구 2과목이 모두 있어야 지원 가능 여부를 계산해요.`;
    if (state.sel.t1 === state.sel.t2) return "탐구 1과 탐구 2에 같은 과목을 고를 수 없어요.";
    for (const s of SUBJ) {
      if (empty(s.key)) continue; const r = String(state.raw[s.key]).trim();
      if (!/^\d+$/.test(r) || +r < 0 || +r > s.max) return `${s.name} 원점수는 0~${s.max}점 사이 정수로 넣어 주세요.`;
      if (s.kind === "rel") {
        const v = scoreOf(s, false); const ov = state.ov[s.key] || {};
        if (!v || v.std == null || v.pct == null) return `${s.name} 표준점수·백분위를 계산할 수 없어요. 직접 넣어 주세요.`;
        if (ov.std != null && (ov.std < 0 || ov.std > 200)) return `${s.name} 표준점수를 다시 확인해 주세요.`;
        if (ov.pct != null && (ov.pct < 0 || ov.pct > 100)) return `${s.name} 백분위는 0~100 사이로 넣어 주세요.`;
        // 목표 점수도 계산돼야 함(빠지면 목표 결과가 조용히 틀어짐)
        const g = scoreOf(s, true);
        if (!s.optional && (!g || g.std == null || g.pct == null)) return `${s.name} 목표 점수를 계산할 수 없어요. 목표 점수를 다시 맞춰 주세요.`;
      }
    }
    return "";
  }

  // ── 계산 요청 ──
  let convTimer = null;
  function requestUpdate() {
    clearTimeout(convTimer);
    convTimer = setTimeout(() => {
      if (!ready || !state.last) return; // 결과를 본 뒤에만 입력 변경을 바로 반영
      const err = validate();
      if (err) { $("#err").textContent = err; $("#result").classList.add("stale"); return; }
      $("#err").textContent = "";
      worker.postMessage({ type: "place", id: ++reqId, scenarios: { now: cellsFor(false), goal: cellsFor(true) } });
    }, 450);
  }
  function run() {
    const e = validate(); $("#err").textContent = e;
    if (e) { focusFirstInvalid(); return; }
    state.pending = true; state.t0 = performance.now();
    $("#go").disabled = true; $("#result").hidden = false; $("#result").classList.add("loading");
    startLoader();
    $("#result").scrollIntoView({ behavior: "smooth", block: "start" });
    worker.postMessage({ type: "place", id: ++reqId, scenarios: { now: cellsFor(false), goal: cellsFor(true) }, wantDepts: !state.depts });
  }
  let loadTimer = null;
  function startLoader() {
    const steps = ["2026 수능 기준으로 점수를 맞추는 중", "대학별 환산 공식으로 계산하는 중", "2026학년도 입시 결과로 맞춘 합격선과 비교하는 중", "상향·소신·적정 대학을 고르는 중"];
    let k = 0; const el = $("#loadtxt"), bar = $("#loadbar");
    el.textContent = steps[0]; bar.style.width = "8%";
    clearInterval(loadTimer);
    loadTimer = setInterval(() => { k = Math.min(steps.length - 1, k + 1); el.textContent = steps[k]; bar.style.width = `${Math.min(92, 8 + k * 28)}%`; }, LOAD_MIN / steps.length);
  }
  function stopLoader() { clearInterval(loadTimer); $("#loadbar").style.width = "100%"; $("#result").classList.remove("loading"); }
  function focusFirstInvalid() {
    const bad = SUBJ.find((s) => (s.opts || s.pick) && !state.sel[s.key]) || MAIN.find((s) => empty(s.key)) || SUBJ.find((s) => !empty(s.key) && (+state.raw[s.key] < 0 || +state.raw[s.key] > s.max));
    const el = bad && (bad.pick && !state.sel[bad.key] ? $(`select[data-k="${bad.key}"]`) : bad.opts && !state.sel[bad.key] ? $(`.seg button[data-k="${bad.key}"]`) : $(`input[data-k="${bad.key}"][data-f="raw"]`));
    if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); el.focus({ preventScroll: true }); }
  }

  // ── 결과: 요약 ──
  const hasGoal = () => MAIN.some((s) => (state.delta[s.key] || 0) > 0);
  function inferTrack() {
    const sci = (c) => /^[G-N]$/.test(c), soc = (c) => /^[O-W]$/.test(c);
    const m = state.sel.math, t = [state.sel.t1, state.sel.t2];
    if ((m === "D" || m === "E") && t.every(sci)) return "자연";
    if (m === "F" && t.every(soc)) return "통합";
    return "all";
  }
  function stdSum(target) {
    let s = 0; const tam = [];
    for (const x of SUBJ) { if (x.kind !== "rel") continue; const v = scoreOf(x, target); if (!v || typeof v.std !== "number") continue; if (x.pick) tam.push(v.std); else s += v.std; }
    tam.sort((a, b) => b - a); return Math.round((s + (tam[0] || 0) + (tam[1] || 0)) * 10) / 10;
  }
  const gradeOfKey = (k, target) => { const s = SUBJ.find((x) => x.key === k); const v = scoreOf(s, target); return v ? v.grade : "-"; };
  const engOf = (target) => { const g = +gradeOfKey("eng", target); return g >= 1 && g <= 9 ? g : 1; };
  // data = {lines, extra}: 새 합격선·추가 모집단위(워커가 첫 계산 때 넘겨 줌). 없으면 picks.js가 원본 기준점으로 목록을 만듦
  const pickOpt = (target) => ({ track: state.track, max: MAX_ROWS, data: state.data, me: stdSum(target), eng: engOf(target) });
  function summarize(out) {
    const D = state.depts;
    const sNow = stdSum(false), sGoal = stdSum(true);
    // 적정 구간(계열 묶음 기준)에 드는 대학 수 — 학과 수가 아님
    const cnt = (res, target) => PK.build(D, res, null, pickOpt(target)).counts.safe.cand;
    const cntNow = cnt(out.now, false), cntGoal = cnt(out.goal, true);
    $("#sum").innerHTML = `
      <div class="box"><div class="lab">지금 성적</div><div class="big">${sNow || "-"}<small> 점</small></div><div class="line">국·수·탐 표준점수 합 · 영어 ${gradeOfKey("eng", false)}등급 · 한국사 ${gradeOfKey("hist", false)}등급</div></div>
      <div class="box t"><div class="lab">목표 점수</div><div class="big">${sGoal || "-"}<small> 점${sGoal > sNow ? ` (+${Math.round((sGoal - sNow) * 10) / 10})` : ""}</small></div><div class="line">영어 ${gradeOfKey("eng", true)}등급 · 한국사 ${gradeOfKey("hist", true)}등급</div></div>`;
    $("#hook").innerHTML = !hasGoal()
      ? "STEP 2에서 과목별로 올릴 수 있는 점수를 넉넉하게 올려 보세요. 그 목표 점수로 상향·소신·적정 대학을 다시 뽑아 드려요."
      : cntGoal > cntNow ? `목표 점수가 되면 적정 구간(든든한 대학)에 드는 대학이 <b>지금 ${f(cntNow)}곳 → 목표 ${f(cntGoal)}곳</b>으로 늘어나요.`
      : cntGoal < cntNow ? `이 목표로는 적정 구간(든든한 대학)에 드는 대학이 <b>지금 ${f(cntNow)}곳 → 목표 ${f(cntGoal)}곳</b>으로 줄어요.`
      : `이 목표로는 적정 구간(든든한 대학)에 드는 대학이 <b>${f(cntNow)}곳</b> 그대로예요. 과목별 점수를 조금 더 올려 보세요.`;
    $("#cnote").textContent = calcNote();
  }
  // 배치표가 계산하지 못하는 점수 범위 안내(원자료 엑셀도 같은 한계): 탐구 백분위 10 미만은 변환표준점수 표(백분위 10~100) 밖이라 변표 0점,
  // 탐구 백분위 0은 미응시로 처리돼 대부분 학과가 지원 불가(예시 학생 1,822 → 147개). 국어·수학 백분위 0은 이렇게 처리되지 않음(1,822 → 1,822)
  function calcNote() {
    const sc = hasGoal() ? [false, true] : [false]; let low = false, zero = false;
    for (const x of SUBJ) {
      if (x.kind !== "rel" || !x.pick) continue;
      for (const t of sc) { const v = scoreOf(x, t); if (!v || typeof v.pct !== "number") continue; if (v.pct <= 0) zero = true; else if (v.pct < 10) low = true; }
    }
    return [zero ? "탐구 백분위가 0이면 배치표가 응시하지 않은 과목으로 봐서, 대부분 대학이 지원 불가로 나와요." : "",
      low ? "탐구 백분위가 10 미만이면 배치표에 변환표준점수가 없어서, 변환표준점수를 쓰는 대학에서는 그 과목이 0점으로 계산돼요." : ""].filter(Boolean).join(" ");
  }

  // ── 결과: 상향·소신·적정 대학 목록 (대학·군·계열 묶음, 구간마다 최대 10곳) ──
  const REF_TIP = "대학별 반영 비율을 반영하지 않은 간이 판정";
  function rowMedKind(row) { // 의약 전용 행: 세부 계열이 하나면 그 이름, 여럿이면 '의약'
    if (!row.med) return null;
    const ks = [...new Set(row.chips.map((c) => c.gy))];
    return ks.length === 1 ? ks[0] : "의약";
  }
  function logoHtml(row) {
    const mk = rowMedKind(row);
    if (mk) return `<div class="lg med" style="background:${MEDCOLOR[mk] || "var(--navy)"}" title="${mk}" role="img" aria-label="${mk} 계열"><svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">${ROD}</svg></div>`;
    const ch = String(row.u).replace(/^(국립|가톨릭)(?=..)/, "").slice(0, 1);
    if (!row.lk) return `<div class="lg"><span class="ini" aria-hidden="true">${esc(ch)}</span></div>`;
    return `<div class="lg"><img src="img/univ/${encodeURIComponent(row.lk)}.png" alt="${esc(row.u)} 로고" data-ini="${esc(ch)}" width="32" height="32" loading="lazy"></div>`;
  }
  function scenario() { const out = state.last; const g = hasGoal(); return { res: g ? out.goal : out.now, other: g ? out.now : null, goal: g }; }
  const repChip = (row) => row.chips[row.rc];
  const findRow = (bandKey, u) => (state.pk && state.pk[bandKey] ? state.pk[bandKey].find((r) => r.u === u) : null);
  const tkey = (u, band) => `${u}|${band}`;
  const isTarget = (u, bandKey) => state.targets.has(tkey(u, bandKey));
  function chipHtml(x, mark) { // '가군 인문·사회·상경 외 2' — 판정 기준 계열(대표 칩)은 진하게
    const t = x.items.map((it) => (mark && it.rep ? `<em>${esc(it.gy)}</em>` : esc(it.gy))).join("·");
    return `<span class="gc"><b>${x.g}군</b><span>${t}${x.rest ? ` 외 ${x.rest}` : ""}</span></span>`;
  }
  function rowHtml(b, row, goal) {
    const rc = repChip(row);
    const chips = PK.chipGroups(row, state.pk.track).map((x) => chipHtml(x, row.chips.length > 1)).join("");
    const o = row.o;
    const now = goal && o ? `<span class="now">지금 ${esc(o.ok ? PK.say(o.ad, o.ref) : "응시 조건 확인")} → 목표</span>` : "";
    const ref = row.pct ? ` <span class="ref" title="${REF_TIP}" role="note" aria-label="참고: ${REF_TIP}">참고</span>` : "";
    const on = isTarget(row.u, b.key);
    return `<li class="urow ${b.key}${on ? " picked" : ""}">${logoHtml(row)}
      <div class="ub"><div class="u">${esc(row.u)}${ref}</div><div class="chips">${chips}</div></div>
      <div class="side"><div class="pr">${now}<b class="pv">${esc(PK.say(rc.ad, rc.ref))}</b></div>
        <button type="button" class="settarget" data-band="${b.key}" data-u="${esc(row.u)}" aria-pressed="${on}" aria-label="${esc(row.u)} ${b.label} 목표 대학으로 설정">${on ? "★ 목표" : "☆ 목표"}</button></div></li>`;
  }
  function bandHtml(b, rows, goal, cnt, few) {
    const n = rows.length, cand = cnt ? cnt.cand : n;
    const sub = !n ? "" : cand > n ? ` <span class="few">(해당 ${f(cand)}곳 중)</span>` : n < 8 ? ` <span class="few">(해당 대학 전부)</span>` : "";
    const title = n ? `${b.label} ${n}곳${sub}` : b.label;
    const list = (rs) => `<ol class="ulist" role="list" style="--rows:${Math.ceil(rs.length / 2)}">${rs.map((r) => rowHtml(b, r, goal)).join("")}</ol>`;
    const gen = rows.filter((r) => !r.med), med = rows.filter((r) => r.med); // 의약 전용 행은 따로 모아 뒤에
    const note = n < 8 && few ? `<p class="bnote">${few}</p>` : "";
    const body = !n ? `<p class="bempty">이 구간에 드는 대학이 없어요.${few ? " " + few : ""}</p>`
      : note + (gen.length ? list(gen) : "") + (med.length ? (gen.length ? `<p class="subh">의·치·한·약·수</p>` : "") + list(med) : "");
    return `<div class="band ${b.key}"><h3><span class="tag" aria-hidden="true">${b.label}</span>${title} <small>${b.desc}</small></h3>${body}</div>`;
  }
  function renderPicks() {
    if (!state.last || !state.depts) return;
    const { res, other, goal } = scenario();
    const pk = PK.build(state.depts, res, other, pickOpt(goal));
    state.pk = pk;
    const anyRef = BANDS.some((b) => pk[b.key].some((r) => r.pct));
    const legend = `<p class="plegend">오른쪽 문구는 ${goal ? "목표 점수" : "지금 성적"} 기준 판정이에요. 계열이 여러 개인 대학은 진하게 표시한 계열 기준이에요.${anyRef ? ` <span class="ref">참고</span> 표시는 ${REF_TIP}이에요.` : ""}</p>`;
    // 상향 후보가 적으면(성적이 높은 학생) 상향·소신이 비는 이유를 상향 구간에 한 번 알려 줌
    const topFew = pk.counts.up.cand < 8 ? `상향·소신에는 합격선이 ${goal ? "목표 점수" : "지금 성적"}보다 조금 높은 대학만 들어가요. 점수가 높을수록 그런 대학이 적어서 곳 수가 적게 나와요.` : "";
    $("#picks").innerHTML = legend + BANDS.map((b) => bandHtml(b, pk[b.key], goal, pk.counts[b.key], b.key === "up" ? topFew : "")).join("");
    renderPlan(pk);
  }

  // ── 목표 대학 고르기 → 무료 상담(로그인 없음). 고른 목표는 '목표: 대학 계열, …' 문구로 복사해 상담 신청서에 붙여 넣게 함 ──
  function targetOf(row, bandKey) { // 목표 = 대학 + 구간 + 판정 기준 계열(학과명은 쓰지 않음)
    const c = repChip(row);
    return { key: tkey(row.u, bandKey), univ: row.u, major: PK.gyLabel([c.gy]), band: bandKey };
  }
  const targetList = () => [...state.targets.values()];
  const targetText = (ts) => "목표: " + ts.map((t) => `${t.univ} ${t.major}`).join(", ");
  function renderTargetBar() {
    const bar = $("#tbar"), ts = targetList();
    document.body.classList.toggle("has-tbar", ts.length > 0);
    if (!ts.length) { bar.hidden = true; return; }
    bar.hidden = false;
    $("#tbar-n").textContent = `목표 대학 ${new Set(ts.map((t) => t.univ)).size}곳`;
    $("#tbar-list").textContent = ts.map((t) => `${t.univ} ${t.major}`).join(", ");
  }
  // 복사: 클릭 처리 안에서 바로(새 탭이 열리기 전에) 복사한다. execCommand가 안 되면 Clipboard API
  function copyNow(text) {
    let ok = false;
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      ok = document.execCommand("copy"); ta.remove();
    } catch (_) { ok = false; }
    if (ok) return Promise.resolve(true);
    try { if (navigator.clipboard) return navigator.clipboard.writeText(text).then(() => true, () => false); } catch (_) {}
    return Promise.resolve(false);
  }
  function copyGoal(text) {
    if (!text) return;
    copyNow(text).then((ok) => toast(ok ? "고른 목표를 복사했어요. 상담 신청서에 붙여 넣어 주세요." : `복사하지 못했어요. 상담 신청서에 이렇게 적어 주세요. ${text}`, 6000));
  }
  const STATE_KEY = "jungsi_state_v2"; // 입력만 이 탭에 잠시 보관(새로고침해도 다시 넣지 않게). 스누코치로 보내지 않음
  function saveLocalState() { try { sessionStorage.setItem(STATE_KEY, JSON.stringify({ sel: state.sel, raw: state.raw, ov: state.ov, delta: state.delta, track: state.track, trackAuto: state.trackAuto })); } catch (_) {} }
  function loadLocalState() {
    try { const v = JSON.parse(sessionStorage.getItem(STATE_KEY) || "null"); if (!v) return false;
      Object.assign(state.sel, v.sel); state.raw = v.raw || {}; state.ov = v.ov || {}; state.delta = v.delta || {}; state.track = v.track || "all"; state.trackAuto = v.trackAuto !== false;
      return true; } catch (_) { return false; }
  }

  // ── 목표까지 가는 길 = 학습코칭 ──
  function renderPlan(pk) {
    const rows = MAIN.map((s) => {
      if (empty(s.key)) return "";
      const r = +state.raw[s.key], to = goalRaw(s), d = Math.max(0, to - rawOf(s)) || 0;
      const a = scoreOf(s, false), b = scoreOf(s, true); const g0 = a ? a.grade : "-", g1 = b ? b.grade : "-";
      return `<tr><th>${s.name}</th><td>${r} → <b>${to}</b></td><td>${d ? `+${d}점` : "-"}</td><td>${g0}${g1 !== g0 ? ` → <b>${g1}</b>` : ""}등급</td></tr>`;
    }).join("");
    // 가장 높은 소신·상향 대학(없으면 적정 맨 위)의 '대학 계열'. 트랙에 맞는 의약이 아닌 행을 먼저 고르고, 없을 때만 나머지
    const byLv = (a) => a.slice().sort((x, y) => y.lv - x.lv);
    const good = (r) => !r.med && !r.cross;
    const hi = byLv([...pk.up, ...pk.mid]);
    const top = hi.find(good) || pk.safe.find(good) || hi[0] || pk.safe[0];
    const topU = top ? top.u : "", topM = top ? PK.gyLabel([repChip(top).gy]) : "";
    const name = top ? `${topU} ${topM}` : "목표 대학";
    $("#plan").innerHTML = `<span class="step">목표까지 가는 길</span>
      <h2>목표 대학까지는 <em>매일 무엇을 얼마나</em> 하느냐가 관건이에요</h2>
      <p class="lead">${hasGoal() ? "위 목록은 아래처럼 점수를 올렸을 때 기준이에요." : "STEP 2에서 목표 점수를 올리면 과목별로 얼마나 올려야 하는지 정리해 드려요."}</p>
      <table class="gap"><thead><tr><th>과목</th><th>원점수</th><th>올릴 점수</th><th>등급</th></tr></thead><tbody>${rows}</tbody></table>
      <ol class="how">
        <li><b>목표 대학 기준으로 과목별 목표 점수와 커리큘럼을 세워요.</b><span>${esc(name)}처럼 목표가 정해지면, 과목마다 몇 점을 어느 시기까지 올릴지 거꾸로 계산해 공부 순서를 짜요.</span></li>
        <li><b>목표 수준에 맞는 공부 페이스와 공부량을 매일 점검해요.</b><span>매일 카톡 플래너 피드백으로 계획대로 했는지, 양과 방법이 목표에 맞는지 확인해요.</span></li>
        <li><b>목표에 못 미치면 무엇을 고칠지 짚고, 계속 조정해요.</b><span>모의고사와 매일 기록을 보고 부족한 과목과 공부법을 바로 고치고, 지치지 않게 격려하며 끝까지 함께 가요.</span></li>
      </ol>
      <a class="bigcta" href="${FORM}?utm_source=jungsi_calc&amp;utm_medium=plan" target="_blank" rel="noopener" data-goal="${esc(top ? `목표: ${name}` : "")}">이 목표로 무료 학습 상담 신청하기</a>
      <p class="sub">서울대 치의학과 대표가 직접, 1:1 화상 컨설팅과 매일 카톡 플래너 피드백으로 관리해요. 첫 상담은 무료예요.${top || state.targets.size ? " 누르면 목표 문구가 복사돼요. 상담 신청서에 붙여 넣어 주세요." : ""}</p>`;
  }

  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "ready") { ready = true; if (state.conv) { $("#loading").textContent = ""; $("#go").disabled = false; } return; }
    if (m.type === "error") { $("#loading").textContent = "데이터를 불러오지 못했어요. 새로고침해 주세요."; return; }
    if (m.type !== "placed") return;
    if (m.depts) state.depts = m.depts;
    if (m.data) state.data = m.data;
    if (m.id !== reqId || !m.out.now.rows || !state.depts) return; // 더 새 요청이 있으면 오래된 결과는 버림
    const show = () => {
      state.last = m.out; $("#result").classList.remove("stale");
      if (state.trackAuto) { state.track = inferTrack(); syncTrack(); }
      summarize(m.out); renderPicks(); renderTargetBar();
      if (state.pending) { state.pending = false; stopLoader(); $("#go").disabled = false; $("#go").textContent = "다시 계산하기"; }
    };
    if (state.pending) setTimeout(show, Math.max(0, LOAD_MIN - (performance.now() - state.t0))); else show();
  };
  loadLocalState();
  fetch("data/conv2026.json").then((r) => r.json()).then((c) => { state.conv = c; clampDeltas(); renderInputs(); renderGoals(); if (ready) { $("#loading").textContent = ""; $("#go").disabled = false; } })
    .catch(() => { $("#loading").textContent = "변환표를 불러오지 못했어요. 새로고침해 주세요."; });

  // ── 이벤트 ──
  function syncTrack() { document.querySelectorAll("#track button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.t === state.track)); }
  // 올린 점수를 0~(만점−지금 원점수) 안으로, 목표 원점수는 나올 수 있는 점수로(99→100, 49→50) 맞춤
  function clampDeltas() { for (const s of MAIN) { if (empty(s.key)) continue; const d = state.delta[s.key] || 0; if (d > 0) setGoal(s, rawOf(s) + d, 1); else state.delta[s.key] = 0; } }
  function refresh(s) { if (s) renderScore(s); renderGoals(); requestUpdate(); }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button, a"); if (!b) return;
    if (b.matches(".seg button")) { const s = SUBJ.find((x) => x.key === b.dataset.k); state.sel[s.key] = b.dataset.c; delete state.ov[s.key]; clampDeltas(); renderInputs(); renderGoals(); requestUpdate(); }
    else if (b.matches(".reset")) { const s = SUBJ.find((x) => x.key === b.dataset.k); delete state.ov[s.key]; refresh(s); }
    else if (b.matches(".stepper button")) {
      // 나올 수 없는 목표 원점수(99·49 등)는 건너뜀: 98 → + → 100, 100 → − → 98
      const s = SUBJ.find((x) => x.key === b.dataset.k); if (empty(s.key)) return; const step = +b.dataset.d;
      setGoal(s, goalRaw(s) + step, step); refresh();
    } else if (b.matches(".nextg")) { const s = SUBJ.find((x) => x.key === b.dataset.k); setGoal(s, goalRaw(s) + +b.dataset.n, 1); clampDeltas(); refresh(); }
    else if (b.matches(".presets button")) {
      const p = b.dataset.p;
      for (const s of MAIN) {
        if (empty(s.key)) continue;
        if (p === "0") state.delta[s.key] = 0;
        else if (p === "next") { const nc = nextCut(s); if (nc) setGoal(s, goalRaw(s) + nc.need, 1); }
        else { const [big, small] = p.split(","); setGoal(s, rawOf(s) + +(s.max === 100 ? big : small), 1); }
      }
      clampDeltas(); refresh();
    } else if (b.id === "go") { saveLocalState(); run(); }
    else if (b.matches(".settarget")) {
      const u = b.dataset.u, band = b.dataset.band, row = findRow(band, u); if (!row) return;
      const k = tkey(u, band), on = !state.targets.has(k);
      if (on) state.targets.set(k, targetOf(row, band)); else state.targets.delete(k);
      b.setAttribute("aria-pressed", on); b.textContent = on ? "★ 목표" : "☆ 목표";
      b.closest(".urow").classList.toggle("picked", on); renderTargetBar();
    } else if (b.id === "tbar-go") copyGoal(targetText(targetList())); // 링크 기본 동작(상담 신청서 새 탭)은 그대로
    else if (b.matches("a.bigcta")) copyGoal(state.targets.size ? targetText(targetList()) : b.dataset.goal);
    else if (b.id === "tbar-clear") { state.targets.clear(); renderTargetBar(); renderPicks(); }
    else if (b.matches("#track button")) { state.track = b.dataset.t; state.trackAuto = false; syncTrack(); if (state.last) { summarize(state.last); renderPicks(); } }
    else if (b.id === "share") {
      const data = { title: "대학 라인 잡기(정시) | 스누코치", url: location.href.split("#")[0] };
      if (navigator.share) navigator.share(data).catch(() => {}); else copyNow(data.url).then((ok) => toast(ok ? "주소를 복사했어요." : "주소창의 주소를 복사해 주세요."));
    }
  });
  document.addEventListener("input", (e) => {
    const t = e.target; if (!t.matches("input[data-k]")) return;
    const s = SUBJ.find((x) => x.key === t.dataset.k);
    if (t.dataset.f === "raw") { state.raw[s.key] = t.value; delete state.ov[s.key]; clampDeltas(); renderScoreSoft(s); renderGoals(); requestUpdate(); return; }
    const ov = (state.ov[s.key] = state.ov[s.key] || {});
    if (t.value === "") delete ov[t.dataset.f]; else ov[t.dataset.f] = +t.value;
    if (t.dataset.f === "std" && ov.pct == null) { const sp = s2p(s, +t.value); const pi = $(`input[data-k="${s.key}"][data-f="pct"]`); if (sp && pi) pi.value = sp.pct; }
    t.classList.add("edited"); const src = t.closest(".ovrow").querySelector(".src"); if (src) src.innerHTML = `직접 입력 <button type="button" class="reset" data-k="${s.key}">되돌리기</button>`;
    const gEl = t.closest(".ovrow").querySelector(".g"); const v = scoreOf(s, false); if (gEl && v) gEl.textContent = `${v.grade ?? "-"}등급`;
    const rn = t.closest(".ovrow").querySelector(".rnote"); if (rn) rn.textContent = pctNote(ov);
    renderGoals(); requestUpdate();
  });
  function renderScoreSoft(s) { renderScore(s); } // 원점수 입력 중 커서는 원점수 칸에 있으므로 아래 칸만 다시 그림
  document.addEventListener("change", (e) => { const t = e.target; if (t.matches("select.subjpick")) { const s = SUBJ.find((x) => x.key === t.dataset.k); state.sel[s.key] = t.value; delete state.ov[s.key]; clampDeltas(); renderScore(s); renderGoals(); requestUpdate(); } });
  // 로고 파일이 없으면 첫 글자 배지로 대체(CSP 때문에 인라인 onerror 대신 캡처 단계에서 처리)
  document.addEventListener("error", (e) => {
    const t = e.target; if (!(t instanceof HTMLImageElement) || !t.dataset.ini) return;
    const sp = document.createElement("span"); sp.className = "ini"; sp.textContent = t.dataset.ini; t.replaceWith(sp);
  }, true);
  let tt = null;
  function toast(msg, ms) { const el = $("#toast"); el.textContent = msg; el.classList.add("on"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("on"), ms || 3600); }

  renderInputs(); renderGoals(); renderTargetBar();
})();
