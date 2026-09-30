// 스누코치 정시 배치 계산기 — 상향·소신·적정 대학 목록 고르기 (DOM 없는 순수 함수)
// 판정(worker.js 결과: 원자료 학과 rows + 추가 모집단위 extra)을 (대학, 군, 계열) 묶음으로 모으고, 구간마다 대학 행을 고른다.
// 학과명은 쓰지 않는다(묶음 단위로만 보여 줌). 브라우저: window.JungsiPicks / node: require("./picks.js")
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JungsiPicks = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  // ads 배열 순서 = 구간 안 우선순위(앞일수록 먼저 고름). fill = 구간이 8곳이 안 될 때 끌어오는 이웃 판정(상향 ← 어려움, 소신 ← 적정 70~90%)
  const BANDS = [
    { key: "up", ads: [4, 5], fill: 6 },
    { key: "mid", ads: [3], fill: 2 },
    { key: "safe", ads: [2, 1] },
  ];
  const GUN = ["가", "나", "다"];
  // 한 구간에 의약 전용 행 최대 수: 인문·통합 트랙 1, 자연·전체 2. 의약이 아닌 후보(이웃 판정 채우기·참고 포함)로 MIN_ROWS를 못 채울 때만 그 구간 판정의 의약 행을 더 허용
  const MED_CAP = { "통합": 1, "자연": 2, all: 2 };
  const medCapOf = (track) => (Object.prototype.hasOwnProperty.call(MED_CAP, track) ? MED_CAP[track] : MED_CAP.all);
  const MIN_ROWS = 8; // 구간마다 이만큼은 채우려는 목표(후보가 없으면 가능한 만큼). 채우기는 이 수까지만(구간 최대 max=10은 그 구간 판정 행만)
  const GUN_MIN = 2; // 후보에 있는 군은 선택 행 중 최소 이만큼(후보가 적으면 가능한 만큼)
  const GOAL_BONUS = 0.5; // 목표 시나리오에서 지금보다 판정이 오른 행의 정렬 가산점(서열값 lv 단위)
  // 상향 채우기 한도: 학생 위치 b*가 그 묶음 70% 선(적정 경계)보다 이 값(b 척도 = 백분위 점) 넘게 낮으면 '어려움' 묶음을 상향으로 끌어오지 않는다(허황된 목표 방지).
  //  근거(CALIBRATION 3-4·11-3·11-4): 70% 선은 예측 70%컷(lv)보다 인문 +0.05~0.2, 자연 최대 +1점 위라 사실상 같은 선이다.
  //  섞은 선 σ는 인문 0.5~1.3, 자연 0.6~2.3이고, 70% 선과 3% 선 사이는 2.4σ(가장 넓은 자연 하위 σ 2.3에서 약 5.5점)다.
  //  예측 오차(LOUO 90분위 1.9점)와 해마다의 변동(25→26 평균 1.2점)을 더해도 70% 선에서 5점 아래는 σ가 가장 넓은 곳의 3% 선 근처라,
  //  그보다 먼 곳은 3% 선 아래 두꺼운 꼬리(관측 6% 대 기대 1%)를 감안해도 목표로 권하기 어렵다. 그래서 5점으로 둔다.
  const FILL_GAP = 5;
  // 목록에서 빼는 규칙(mismatch)
  //  (가) 환산점수 역행 식(w=1, 가천대 전형Ⅰ — 새 기준점 학과·원본 기준점 학과·이 식을 빌린 추가 모집단위 모두)으로만 판정한 묶음은 적정 구간에만 둔다.
  //      이 식은 성적이 올라도 환산점수가 내려가는 구간이 있고 합격선은 단조로 맞춘 곡선으로 만들어서, 판정이 실제보다 어렵게만 틀린다
  //      (적정은 안전, 상향·소신은 이 역행 때문일 수 있음). 목표 시나리오에서는 이런 묶음의 판정을 '지금'보다 나쁘게 두지 않는다(목표 점수는 과목마다 지금 이상이라서)
  //  (나) 공통척도 점검: 합격선 파일에 없어 원본 기준점을 그대로 쓰는 학과로만 된 묶음에만 적용한다(opt.me = 학생 국·수·탐 표준점수 합).
  //  - 상향·소신인데 묶음 기준점(26수능 표준점수 합)이 학생보다 GAP + GAP_ENG×(영어 등급−1) 이상 낮음
  //  - 소신·적정인데 기준점이 학생보다 GAP 이상 높음
  //  - 적정(ad 2)인데 기준점이 학생보다 (위 허용 폭 + GAP) 이상 낮음
  //  - 판정이 치우친 묶음(cz): cz=−1이 소신·적정인데 학생 < 기준점, cz=1이 상향·소신인데 학생 > 기준점 + GAP_ENG×(영어 등급−1)
  const GAP = 15;
  const GAP_ENG = 5;

  // 의약(med=1)은 한 계열로 묶지 않고 의예·치의예·한의예·약학·수의예로 나눈다(같은 대학 안에서도 점수대가 크게 달라서)
  const MED_KINDS = ["의예", "치의예", "한의예", "약학", "수의예"];
  const MED_RE = [[/^치/, "치의예"], [/^한의/, "한의예"], [/약/, "약학"], [/^수의/, "수의예"]];
  function medKind(d) {
    if (!d || !d.med) return null;
    const m = String(d.m || "");
    for (const [re, k] of MED_RE) if (re.test(m)) return k;
    return "의예";
  }
  const isMedGy = (gy) => MED_KINDS.includes(gy);
  const gyOf = (d) => (d.med ? medKind(d) : d.gy || "기타");
  const EXCLUDED_GY = "예체능"; // 실기·예체능 계열은 목록에서 뺌

  const uOf = (d) => d.u2 || d.u;
  const valid = (r) => !!(r && !r.x && r.ok && r.ad != null);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const rowsOf = (x) => (Array.isArray(x) ? x : x && x.rows ? x.rows : null);
  const extraOf = (x) => (x && !Array.isArray(x) && Array.isArray(x.extra) ? x.extra : null);
  function trackOk(d, track) { return !track || track === "all" || (track === "자연" ? d.t === "자연" : d.t !== "자연"); }
  function median(a) {
    const s = a.slice().sort((x, y) => x - y), n = s.length;
    if (!n) return null;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  // 판정 중앙값: 항목 수 기준, 짝수면 더 보수적인(큰) 쪽
  function medianAd(items) { const s = items.map((x) => x.r.ad).sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
  // 원본 기준점 학과의 공통척도 값(국·수·탐 표준점수 합 척도): 26수능 표준점수(std26) → 같은 대학 안 추정(pos) → 참고 컷(ec)
  const stdOf = (d) => (isNum(d.std26) ? d.std26 : isNum(d.pos) ? d.pos : isNum(d.ec) ? d.ec : null);

  // ── b 척도 위치(채우기 순서·한도용) ──
  // b = 전형적 과목 구성 학생의 국수탐 평균백분위 눈금(lv와 같은 눈금). 환산식 학과는 base.json 곡선(그 학과 환산식을 전형적 학생에게 적용한 환산점수)으로
  // 학생 환산점수 q와 기준점(90·70·40·10·3% 선)을 b로 되돌린다. 곡선은 단조로 보고(누적 최댓값), 평평한 구간은 왼쪽 끝, 양 끝 밖은 끝 기울기로 연장
  function invCurve(bg, c, q) {
    const n = Math.min(bg.length, c.length);
    if (n < 2 || !isNum(q)) return null;
    const m = new Array(n); let mx = -Infinity;
    for (let i = 0; i < n; i++) { mx = Math.max(mx, c[i]); m[i] = mx; }
    const lin = (i, j) => (m[j] - m[i]) / (bg[j] - bg[i]);
    if (q <= m[0]) { const s = lin(0, 1); return s > 0 ? bg[0] + (q - m[0]) / s : bg[0]; }
    if (q > m[n - 1]) { const s = lin(n - 2, n - 1); return s > 0 ? bg[n - 1] + (q - m[n - 1]) / s : bg[n - 1]; }
    let lo = 0, hi = n - 1; // m[lo] < q <= m[hi]
    while (hi - lo > 1) { const k = (lo + hi) >> 1; if (m[k] < q) lo = k; else hi = k; }
    let a = hi; while (a > 0 && m[a - 1] === m[hi]) a--; // 평평한 구간 → 왼쪽 끝
    if (a < hi) return bg[a];
    return bg[lo] + ((bg[hi] - bg[lo]) * (q - m[lo])) / (m[hi] - m[lo]);
  }
  // 판정 항목의 {b: 학생 위치, b3: 3% 선, b70: 70% 선}. 단순 비교(pct)는 학생 값(영역 평균 백분위 + 영어·한국사 보정)과 기준점이 이미 백분위 눈금
  // (pct 모집단위의 lv는 기준점과 눈금이 달라 쓰지 않는다). 곡선·기준점이 없으면 null
  function posOf(it, data) {
    const B = data && data.base, T = (a) => Array.isArray(a) && a.length === 5 && a.every(isNum);
    const curve = (k) => { const b = B && B.d && B.d[k]; return b && b[0] >= 0 && B.c[b[0]] ? B.c[b[0]] : null; };
    let b, b3, b70;
    if (it.src === "d") {
      const c = curve(it.d.k), L = data.lines && data.lines.d ? data.lines.d[it.d.k] : null, t = L && L.t ? L.t : it.d.th;
      if (!c || !T(t)) return null;
      b = invCurve(B.bg, c, it.r.q); b3 = invCurve(B.bg, c, t[4]); b70 = invCurve(B.bg, c, t[1]);
    } else if (it.x.m === "b") {
      const c = curve(it.x.q);
      if (!c || !T(it.x.tb)) return null;
      b = invCurve(B.bg, c, it.r.q); b3 = it.x.tb[4]; b70 = it.x.tb[1];
    } else {
      if (!T(it.x.th)) return null;
      b = it.r.v; b3 = it.x.th[4]; b70 = it.x.th[1];
    }
    return isNum(b) && isNum(b3) && isNum(b70) ? { b, b3, b70 } : null;
  }

  // 0단계: 판정 항목. tier "f" = 원자료 환산식(학과 자기 식 또는 같은 대학 식을 빌림), "p" = 기준 영역 백분위 단순 비교
  //  - 합격선(lines.d)이 있는 학과: 새 기준점. 서열값 lv = lines.d[k].lv. w=1(성적이 올라도 환산점수가 내려가는 구간이 있는 식, lines.w)은 같은 묶음에 다른 항목이 있으면 판정에서 뺌
  //  - lines.d에 없는 학과: 원본 기준점 그대로. lv = lines.r[k]. eo·cz(원본 기준점 이상치)는 3개 이상 묶음에서 판정에서 뺌
  //  - nv(원자료 식 척도 불일치, 강원대 삼척·도계)는 늘 뺀다. 같은 모집단위가 추가 모집단위(단순 비교)로 들어 있음
  //  - 합격선 파일이 없으면(옛 캐시·불러오기 실패) 전부 원본 기준점: lv = 26수능 표준점수 합, 추가 모집단위는 쓰지 않음
  function items(D, res, opt) {
    const R = rowsOf(res) || [], XR = extraOf(res);
    const data = opt.data || {};
    const L = data.lines && data.lines.d ? data.lines : null;
    const E = L && data.extra && Array.isArray(data.extra.units) ? data.extra : null;
    const out = [];
    for (let i = 0; i < D.length; i++) {
      const d = D[i], r = R[i];
      if (d.sp || d.gy === EXCLUDED_GY || !trackOk(d, opt.track) || !valid(r)) continue;
      if (d.nv) continue;
      const ln = L ? L.d[d.k] : null;
      const lv = ln ? ln.lv : L ? L.r && L.r[d.k] : stdOf(d);
      out.push({ src: "d", i, d, r, u: uOf(d), g: d.g, gy: gyOf(d), lv: isNum(lv) ? lv : null, tier: "f", old: !ln, w: !!((L && L.w && L.w[d.k]) || (ln && ln.w)),
        odd: ln ? false : !!(d.eo || d.cz), cz: ln ? 0 : d.cz || 0, std: ln ? null : stdOf(d), lk: d.lk || d.u });
    }
    if (E && XR) E.units.forEach((x, j) => {
      const r = XR[j];
      if (!valid(r) || x.gy === EXCLUDED_GY || !trackOk(x, opt.track)) return;
      out.push({ src: "x", j, x, r, u: x.u, g: x.g, gy: x.md || x.gy, lv: isNum(x.lv) ? x.lv : null, tier: x.m === "p" ? "p" : "f", old: false, w: !!x.w,
        odd: false, cz: 0, std: null, lk: x.lk || null });
    });
    return out;
  }

  // 1단계: (대학, 군, 계열) 묶음. 환산식 항목(tier f)이 있으면 그것만으로 판정하고, 없을 때만 단순 비교(tier p)로 판정(pct=true)
  // 판정 = 판정에 쓴 항목(pool)의 판정 중앙값(짝수면 보수적인 쪽). 서열값 lv = 같은 pool의 lv 중앙값(짝수면 높은 쪽 — 판정과 같은 쪽)
  // ref = 판정에 쓴 항목 중 하나라도 참고 판정(ref=1)이면 1(보수적)
  function groups(D, res, opt) {
    const map = new Map();
    for (const it of items(D, res, opt)) {
      const key = it.u + "\u0001" + it.g + "\u0001" + it.gy;
      let G = map.get(key);
      if (!G) map.set(key, (G = { key, u: it.u, g: it.g, gy: it.gy, all: [] }));
      G.all.push(it);
    }
    const out = [];
    for (const G of map.values()) {
      const F = G.all.filter((x) => x.tier === "f"), pct = !F.length, mem = pct ? G.all : F;
      let pool = mem.some((x) => !x.w) ? mem.filter((x) => !x.w) : mem; // 환산점수 역행 식은 다른 학과가 있으면 뺌
      if (mem.length >= 3) { const c = pool.filter((x) => !x.odd); if (c.length) pool = c; } // 원본 기준점 이상치(eo·cz)는 3개 이상 묶음에서만 뺌
      const wOnly = pool.every((x) => x.w);
      const ad = medianAd(pool);
      const lvs = pool.map((x) => x.lv).filter(isNum).sort((a, b) => a - b), lv = lvs.length ? lvs[Math.floor(lvs.length / 2)] : 0;
      const old = mem.every((x) => x.old);
      const stds = old ? mem.map((x) => x.std).filter(isNum) : [], std = stds.length ? median(stds) : null;
      const czs = old ? pool.reduce((s, x) => s + (x.cz || 0), 0) : 0, cz = Math.abs(czs) * 2 > pool.length ? Math.sign(czs) : 0;
      const ref = mem.some((x) => x.r.ref) ? 1 : 0;
      const atAd = pool.filter((x) => x.r.ad === ad), clean = atAd.filter((x) => !x.odd && !x.w), cands = clean.length ? clean : atAd;
      let rep = cands[0], best = Infinity;
      for (const x of cands) { const dist = isNum(x.lv) ? Math.abs(x.lv - lv) : Infinity; if (dist < best) { best = dist; rep = x; } }
      const lk = rep.lk || (mem.find((x) => x.lk) || {}).lk || null;
      out.push({ key: G.key, u: G.u, g: G.g, gy: G.gy, ad, lv, n: mem.length, rep, med: isMedGy(G.gy), cz, ref, pct, old, std, lk, wOnly });
    }
    return out;
  }

  // 목표 시나리오 묶음: (가) 환산점수 역행 식으로만 판정한 묶음은 '지금' 판정보다 나쁘게 두지 않는다
  //  (목표 점수는 과목마다 지금 이상이라 실제 위치가 나빠질 수 없는데, 이 식은 수학만 올려도 역행 구간에서 판정이 떨어짐). gsO = 지금 성적 묶음(key → 묶음)
  function groupsFor(D, res, other, gopt) {
    const gs = groups(D, res, gopt);
    const gsO = other ? new Map(groups(D, other, gopt).map((G) => [G.key, G])) : null;
    if (gsO) for (const G of gs) { const Gn = gsO.get(G.key); if (G.wOnly && Gn && Gn.ad < G.ad) { G.ad = Gn.ad; G.held = true; } }
    return { gs, gsO };
  }

  const hasGun = (row, g) => row.chips.some((c) => c.g === g);

  // 4단계: 우선순위대로 room개까지 고르되 의약 전용 행 한도(cap)와 군 균형을 맞춘다
  //  base = 이 구간에서 먼저 고른 행(군 균형 셈에 넣고, 그 대학은 다시 고르지 않음). cands 안에 같은 대학 행이 여럿이면(채우기 행) 앞선 것 하나만
  function select(cands, room, cap, base) {
    base = base || [];
    const sel = [], used = new Set(base.map((r) => r.u)), baseU = new Set(used); let medN = 0;
    const take = (r) => { sel.push(r); used.add(r.u); if (r.med) medN++; };
    for (const r of cands) {
      if (sel.length >= room) break;
      if (used.has(r.u) || (r.med && medN >= cap)) continue;
      take(r);
    }
    const inSel = new Set(sel);
    const baseCnt = (g) => base.reduce((k, r) => k + (hasGun(r, g) ? 1 : 0), 0);
    const need = {};
    for (const g of GUN) {
      const nm = new Set(), md = new Set(); // 이 군이 있는 후보 대학(의약이 아닌 행 / 의약 전용 행만)
      for (const r of cands) if (!baseU.has(r.u) && hasGun(r, g)) (r.med ? md : nm).add(r.u);
      for (const u of nm) md.delete(u);
      need[g] = Math.min(GUN_MIN, baseCnt(g) + nm.size + Math.min(cap, md.size), baseCnt(g) + room);
    }
    const cnt = (g) => baseCnt(g) + sel.reduce((k, r) => k + (hasGun(r, g) ? 1 : 0), 0);
    for (let pass = 0; pass < 2; pass++) {
      for (const g of GUN) {
        while (cnt(g) < need[g]) {
          // 이 군이 있는 후보를 우선순위대로: 자리가 남으면 넣고, 차 있으면 뒤쪽(우선순위 낮은) 행부터 빼도 다른 군 최소치가 깨지지 않는 행과 교체.
          // 의약 한도가 찼으면 의약 후보는 의약 행하고만 바꾼다
          let done = false;
          for (const next of cands) {
            if (inSel.has(next) || used.has(next.u) || !hasGun(next, g)) continue;
            const full = next.med && medN >= cap;
            if (sel.length < room && !full) { take(next); inSel.add(next); done = true; break; }
            let vi = -1;
            for (let k = sel.length - 1; k >= 0; k--) {
              const v = sel[k]; if (hasGun(v, g) || (full && !v.med)) continue;
              if (GUN.every((h) => h === g || !hasGun(v, h) || cnt(h) - 1 >= need[h])) { vi = k; break; }
            }
            if (vi < 0) continue;
            const [x] = sel.splice(vi, 1); inSel.delete(x); used.delete(x.u); if (x.med) medN--;
            take(next); inSel.add(next); done = true; break;
          }
          if (!done) break;
        }
      }
    }
    return sel;
  }

  // 목록에서 빼야 하면 true: (가) 환산점수 역행 식만으로 판정한 묶음의 상향·소신 (나) 원본 기준점 묶음의 공통척도 점검
  //  채우기로 끌어오는 이웃 판정 묶음도 들어갈 구간(bandKey) 기준으로 같은 점검을 한다
  function mismatch(bandKey, G, me, eng) {
    if (G.wOnly && bandKey !== "safe") return true;
    if (!G.old || me == null || !(G.std > 0)) return false;
    const engW = GAP_ENG * Math.max(0, (eng || 1) - 1); // 영어가 낮아서 판정이 어려워질 수 있는 폭(표준점수 합, 추정)
    const low = GAP + engW;
    if (bandKey !== "safe" && G.std <= me - low) return true;
    if (bandKey !== "up" && G.std >= me + GAP) return true;
    if (bandKey === "safe" && G.ad === 2 && G.std <= me - low - GAP) return true;
    if (G.cz < 0 && bandKey !== "up" && G.std > me) return true;
    if (G.cz > 0 && bandKey !== "safe" && G.std < me - engW) return true;
    return false;
  }

  // 대학 행 만들기: 같은 대학의 묶음(칩)을 한 행으로, 대표 칩 = 구간 안 우선순위(ads 순서)가 가장 앞선 칩(같으면 lv 높은 칩)
  // 대표 칩·서열은 학생 트랙에 맞는 계열 칩에서 먼저 고른다(인문 학생 행의 대표가 공학·보건이 되지 않게). 트랙에 맞는 칩이 없는 행(cross)은 뒤로
  function finalizeRow(row, ads, track) {
    const cross = CROSS[track] || CROSS.all;
    row.chips.sort((x, y) => GUN.indexOf(x.g) - GUN.indexOf(y.g) || (x.med ? 1 : 0) - (y.med ? 1 : 0) || y.lv - x.lv);
    row.med = row.chips.every((x) => x.med);
    // 의약 칩이 섞인 행은 의약이 아닌 칩으로 대표·서열을 정한다(의대 컷이 대학 전체 순위를 끌어올리지 않게)
    const nonMed = row.med ? row.chips : row.chips.filter((x) => !x.med);
    const fit = nonMed.filter((x) => !cross.has(x.gy));
    row.cross = !fit.length;
    const base = fit.length ? fit : nonMed;
    let rc = row.chips.indexOf(base[0]);
    row.chips.forEach((c, k) => {
      if (!base.includes(c)) return;
      const a = ads.indexOf(c.ad), z = ads.indexOf(row.chips[rc].ad);
      if (a < z || (a === z && c.lv > row.chips[rc].lv)) rc = k;
    });
    const c = row.chips[rc];
    row.rc = rc; row.best = c.ad; row.ref = c.ref; row.o = c.o;
    row.pct = row.chips.every((x) => x.pct);
    row.lk = c.lk || (row.chips.find((x) => x.lk) || {}).lk || null;
    row.lv = Math.max(...base.map((x) => x.lv));
    // 지금보다 판정이 오른 행은 같은 우선순위 안에서 조금 앞으로
    const up = !!(c.o && (!c.o.ok || c.o.ad == null || c.o.ad > c.ad));
    row.sk = row.lv + (up ? GOAL_BONUS : 0);
    return row;
  }
  function finalize(byU, b, track) {
    const rows = [...byU.values()].map((row) => finalizeRow(row, b.ads, track));
    rows.sort((x, y) => (x.cross ? 1 : 0) - (y.cross ? 1 : 0) || b.ads.indexOf(x.best) - b.ads.indexOf(y.best) || y.sk - x.sk || (x.u < y.u ? -1 : x.u > y.u ? 1 : 0));
    return rows;
  }
  // 이웃 판정 채우기 후보(묶음 하나 = 행 하나, fill=true, gkey = 묶음 키). 원자료·빌린 식(F)과 간이 판정(P)으로 나눠 우선순위 순으로 돌려줌
  //  상향 ← 어려움(ad 6): 학생 위치 b*가 3% 선(상향 경계)에 가까운 것부터. 70% 선보다 FILL_GAP 넘게 낮은 묶음과 위치를 구할 수 없는 묶음은 뺀다
  //  소신 ← 적정 중 70~90%(ad 2): b*가 70% 선(소신 경계)에 가까운 것부터(위치를 구할 수 없으면 뒤로, 그 안에서는 lv 높은 것부터)
  //  트랙에 맞는 계열 행을 먼저(교차 계열만 있는 행은 뒤로 — 구간 안 행과 같은 규칙)
  //  간이 판정(pct) 묶음은 기준 영역(예: 상위 두 영역 평균)이 lv 눈금(국수탐 평균)과 달라 판정과 lv가 크게 어긋나는 곳이 있다
  //  (예: 387점 인문 학생에게 lv 79.5인 대학이 70~90%). 40명 점검에서 ad 2 묶음의 lv − 학생 수준은 환산식 묶음 −3.9~+0.8(5~95%),
  //  간이 묶음 중앙값 −5.9·5% −15.4였다. 그래서 간이 묶음은 lv가 학생 수준 bRef(환산식 묶음 b* 중앙값)에서 FILL_GAP 넘게 떨어지면 채우지 않는다
  function neighbors(b, gs, data, track, me, eng, chipOf, bRef) {
    const L = [];
    for (const G of gs) {
      if (G.ad !== b.fill || mismatch(b.key, G, me, eng)) continue;
      if (G.pct && bRef != null && Math.abs(G.lv - bRef) > FILL_GAP) continue;
      const p = posOf(G.rep, data);
      let d = null;
      if (b.fill === 6) { if (!p || p.b70 - p.b > FILL_GAP) continue; d = p.b3 - p.b; } else if (p) d = p.b - p.b70;
      const row = finalizeRow({ u: G.u, band: b.key, chips: [chipOf(G)], fill: true, gkey: G.key }, [b.fill], track);
      L.push({ row, d, pct: G.pct });
    }
    const dk = (x) => (x.d == null ? Infinity : x.d);
    L.sort((x, y) => (x.row.cross ? 1 : 0) - (y.row.cross ? 1 : 0) || dk(x) - dk(y) || y.row.lv - x.row.lv || (x.row.u < y.row.u ? -1 : x.row.u > y.row.u ? 1 : 0));
    return { F: L.filter((x) => !x.pct).map((x) => x.row), P: L.filter((x) => x.pct).map((x) => x.row) };
  }
  // 표시 순서: 의약이 아닌 행 → 의약 전용 행, 그 안에서 트랙에 맞는 행 → 교차 계열만 있는 행, 각각 lv 내림차순(채우기 행도 같은 규칙으로 섞임)
  const showOrder = (b) => (x, y) => (x.med ? 1 : 0) - (y.med ? 1 : 0) || (x.cross ? 1 : 0) - (y.cross ? 1 : 0) || y.lv - x.lv
    || b.ads.indexOf(x.best) - b.ads.indexOf(y.best) || (x.u < y.u ? -1 : x.u > y.u ? 1 : 0);

  /**
   * build(D, res, other, opt)
   *  D: depts.json 배열, res: worker 결과 {rows, extra}(또는 rows 배열) — 행 {ok,q,v,ad,p,ref,x}
   *  other: 목표 시나리오일 때 '지금 성적' 결과(없으면 null)
   *  opt: {track:'all'|'자연'|'통합', max:10, data:{lines, extra, base}, me: 국·수·탐 표준점수 합, eng: 영어 등급(1~9)}
   *   data.base = base.json(환산식 곡선). 없으면 원자료·빌린 식 묶음의 b 위치를 못 구해 상향 채우기는 간이 판정 묶음만 쓴다
   *  → out.bRef = 학생 수준(환산식 묶음 b* 중앙값, 점검용)
   *  → { up:[row], mid:[row], safe:[row], counts:{up:{cand,shown,drop,candF,pct,fill,fillCand},…}, track }
   *   cand = 구간 판정 묶음이 있는 대학 수(적정은 소신으로 옮긴 묶음을 뺀 수), pct = 표시한 간이 판정 행, fill = 표시한 채우기 행, fillCand = 채우기 후보 대학 수
   *  row: {u, band, chips:[{g,gy,ad,ref,pct,i,j,n,lv,med,o,lk}], rc(대표 칩 번호), best, ref, pct, lk, lv, med, cross, o, fill?, gkey?}
   *  chip.o(목표 시나리오일 때): '지금 성적'에서 같은 (대학, 군, 계열) 묶음의 판정 {ad, ref, ok} — 지금 목록과 같은 계산.
   *   고른 행의 대표 칩이 지금 ad 6이면 near(지금 위치가 70% 선에서 FILL_GAP 안)도 붙인다 → sayNow(row)
   *  선택(구간마다, 한 대학은 한 행): ① 구간 판정 원자료·빌린 식 행 최대 max개 → MIN_ROWS에 못 미치면 ② 이웃 판정 원자료·빌린 식 묶음
   *   → ③ 구간 판정 간이(참고) 행 → ④ 이웃 판정 간이 묶음 순으로 MIN_ROWS까지 채운다. 의약 전용 행은 medCapOf(track)까지이고,
   *   ①~④를 다 써도 MIN_ROWS가 안 될 때만 구간 판정 의약 전용 행(① → ③)을 더 넣는다. 소신에 넣은 적정(ad 2) 묶음은 적정 목록에서 뺀다(한 묶음은 한 구간에만)
   *  표시 순서: 의약이 아닌 행 먼저, 그다음 의약 전용 행. 각각 lv 내림차순.
   */
  function build(D, res, other, opt) {
    opt = opt || {};
    const max = opt.max || 10;
    const track = opt.track || "all";
    const data = opt.data || {};
    const gopt = { track, data: opt.data };
    const { gs, gsO } = groupsFor(D, res, other, gopt);
    const me = typeof opt.me === "number" && opt.me > 0 ? opt.me : null;
    const eng = typeof opt.eng === "number" && opt.eng >= 1 ? opt.eng : 1;
    const cap = medCapOf(track), goal = Math.min(max, MIN_ROWS);
    // 학생 수준(b 눈금): 환산식 묶음 대표 항목의 b* 중앙값. 간이 판정 채우기 묶음의 눈금 점검에만 씀(곡선이 없으면 null → 점검 안 함)
    const bs = gs.filter((G) => !G.pct).map((G) => posOf(G.rep, data)).filter(Boolean).map((p) => p.b);
    const bRef = bs.length ? median(bs) : null;
    const out = { counts: {}, track, bRef };
    const moved = new Set(); // 소신 채우기로 옮긴 적정 묶음 키
    const chipOf = (G) => {
      let o = null;
      if (gsO) { const Gn = gsO.get(G.key); o = Gn ? { ad: Gn.ad, ref: Gn.ref, ok: true } : { ad: null, ref: 0, ok: false }; }
      const rep = G.rep;
      return { g: G.g, gy: G.gy, ad: G.ad, ref: G.ref, pct: G.pct, i: rep.src === "d" ? rep.i : null, j: rep.src === "x" ? rep.j : null,
        n: G.n, lv: G.lv, med: G.med, o, lk: G.lk };
    };
    for (const b of BANDS) {
      const byF = new Map(), byP = new Map(); let drop = 0;
      for (const G of gs) {
        if (!b.ads.includes(G.ad) || moved.has(G.key)) continue;
        if (mismatch(b.key, G, me, eng)) { drop++; continue; }
        const M = G.pct ? byP : byF;
        let row = M.get(G.u);
        if (!row) M.set(G.u, (row = { u: G.u, band: b.key, chips: [] }));
        row.chips.push(chipOf(G));
      }
      const rowsF = finalize(byF, b, track), rowsP = finalize(byP, b, track);
      const nb = b.fill ? neighbors(b, gs, data, track, me, eng, chipOf, bRef) : { F: [], P: [] };
      const tiers = [rowsF, nb.F, rowsP, nb.P];
      let sel = select(rowsF, max, cap);
      for (const T of tiers.slice(1)) {
        if (sel.length >= goal) break;
        const medN = sel.reduce((k, r) => k + (r.med ? 1 : 0), 0);
        sel = sel.concat(select(T, goal - sel.length, Math.max(0, cap - medN), sel));
      }
      // 의약 한도 완화(기존 규칙을 채우기 뒤로 미룸): ①~④를 다 쓰고도 MIN_ROWS가 안 되면 그 구간 판정의 의약 전용 행(① → ③)을 더 넣는다.
      //  이웃 판정(채우기) 의약 행은 한도를 넘기지 않는다(구간 밖 판정인 의약 행으로 목록이 쏠리지 않게)
      for (const T of [rowsF, rowsP]) {
        if (sel.length >= goal) break;
        sel = sel.concat(select(T.filter((r) => r.med), goal - sel.length, Infinity, sel)); // 군 균형도 같이 맞춤
      }
      if (b.fill === 2) for (const r of sel) if (r.fill) moved.add(r.gkey);
      // 목표 시나리오: '지금' 판정이 어려움(ad 6)인 행은 지금 위치가 70% 선에서 FILL_GAP 안이면 near=true('지금 쉽지 않아요'),
      //  아니면 '지금 어려워요'. 지금 목록에서 상향 채우기로 나오는 묶음과 같은 기준이라 두 화면 문구가 맞는다(sayNow)
      if (gsO) for (const r of sel) {
        const o = r.o, c = r.chips[r.rc];
        if (!o || !o.ok || o.ad !== 6 || o.near !== undefined) continue;
        const Gn = gsO.get(r.u + "\u0001" + c.g + "\u0001" + c.gy), p = Gn ? posOf(Gn.rep, data) : null;
        o.near = !!(p && p.b70 - p.b <= FILL_GAP);
      }
      sel.sort(showOrder(b));
      sel.forEach((r) => delete r.sk);
      out[b.key] = sel;
      const cand = new Set(rowsF.map((r) => r.u).concat(rowsP.map((r) => r.u))).size;
      out.counts[b.key] = { cand, shown: sel.length, drop, candF: rowsF.length, pct: sel.filter((r) => r.pct).length,
        fill: sel.filter((r) => r.fill).length, fillCand: new Set(nb.F.concat(nb.P).map((r) => r.u)).size };
    }
    return out;
  }

  // ── 판정 문구(확률 숫자는 쓰지 않음). ref=1(참고 판정)은 네 단계만 ──
  const SAY = { 1: "여유 있어요", 2: "무난해요", 3: "해 볼 만해요", 4: "도전해 볼 만해요", 5: "쉽지 않아요", 6: "어려워요" };
  const SAY_REF = { 1: "무난해요", 2: "무난해요", 3: "해 볼 만해요", 4: "도전 구간이에요", 5: "도전 구간이에요", 6: "어려워요" };
  // 채우기 행(row.fill)은 들어간 구간에 맞춰 이웃 판정을 부른다: 상향의 어려움(ad 6) → '쉽지 않아요', 소신의 70~90%(ad 2) → '무난한 쪽이에요'
  const SAY_FILL = { up: { 6: "쉽지 않아요" }, mid: { 2: "무난한 쪽이에요" } };
  // fill = 채우기 행이면 그 구간 키(row.fill ? row.band : null)
  function say(ad, ref, ok, fill) {
    if (ok === false) return "응시 조건 확인";
    const f = fill && SAY_FILL[fill] && SAY_FILL[fill][ad];
    return f || (ref ? SAY_REF : SAY)[ad] || "-";
  }
  const sayRow = (row, ad, ref, ok) => say(ad, ref, ok, row && row.fill ? row.band : null);
  // 목표 시나리오의 '지금' 문구(row.o = 대표 칩의 지금 판정). 어려움(ad 6)은 지금 위치가 상향 채우기 기준(70% 선에서 FILL_GAP 안)이면
  //  '쉽지 않아요'(지금 목록에서 상향 채우기로 보이는 문구), 아니면 '어려워요'. 행이 채우기 행이어도 지금 판정이 멀면 '어려워요'로 둔다
  function sayNow(row) {
    const o = row && row.o;
    if (!o) return "";
    if (!o.ok) return "응시 조건 확인";
    if (o.ad === 6) return o.near ? SAY_FILL.up[6] : say(6, o.ref, true);
    return say(o.ad, o.ref, true, row.fill ? row.band : null);
  }

  // ── 표시용 문구(학과명은 쓰지 않음) ──
  // 계열 순서: 학생 트랙에 맞는 계열 먼저, 교차 계열은 뒤로
  const ORDER = {
    "통합": ["인문", "사회", "상경", "교육", "자유전공", "자연", "공학", "보건", ...MED_KINDS],
    "자연": ["자연", "공학", "보건", ...MED_KINDS, "자유전공", "인문", "사회", "상경", "교육"],
    all: ["인문", "사회", "상경", "교육", "자연", "공학", "보건", ...MED_KINDS, "자유전공"],
  };
  const CROSS = { "통합": new Set(["자연", "공학", "보건", ...MED_KINDS]), "자연": new Set(["인문", "사회", "상경", "교육"]), all: new Set() };
  const orderOf = (track) => ORDER[track] || ORDER.all;
  const gyRank = (gy, track) => { const k = orderOf(track).indexOf(gy); return k < 0 ? 99 : k; };
  // ['인문','사회','자유전공','약학'] → {main:['인문','사회'], free:true, med:['약학']}
  function gyParts(gys) {
    const u = gys.filter((g, k) => gys.indexOf(g) === k);
    return { main: u.filter((g) => g !== "자유전공" && !isMedGy(g)), free: u.includes("자유전공"), med: MED_KINDS.filter((k) => u.includes(k)) };
  }
  // '인문·사회계열·자유전공', '의예·약학' — 자유전공과 의약 세부 계열에는 '계열'을 붙이지 않음
  function gyLabel(gys) {
    const x = gyParts(gys), parts = [];
    if (x.main.length) parts.push(x.main.join("·") + "계열");
    if (x.free) parts.push("자유전공");
    return parts.concat(x.med).join("·");
  }
  /**
   * chipGroups(row, track, per=3) — 같은 군 칩을 하나로:
   *  [{g:'가', items:[{gy:'인문', rep:true}, …], rest:2, cross:false, label:'가군 인문·사회·상경 외 2'}]
   *  군당 계열은 트랙에 맞는 것 먼저 최대 per개, 나머지는 '외 N'. 대표 칩(행 판정 기준)은 항상 보이는 자리에 둔다.
   */
  function chipGroups(row, track, per) {
    per = per || 3; track = track || "all";
    const rc = row.chips[row.rc];
    const out = [];
    for (const c of row.chips) {
      let x = out.find((y) => y.g === c.g);
      if (!x) out.push((x = { g: c.g, gys: [] }));
      if (!x.gys.includes(c.gy)) x.gys.push(c.gy);
    }
    for (const x of out) {
      const s = x.gys.slice().sort((a, b) => gyRank(a, track) - gyRank(b, track));
      let shown = s.slice(0, per);
      const repGy = rc && rc.g === x.g ? rc.gy : null;
      if (repGy && !shown.includes(repGy)) shown = shown.slice(0, per - 1).concat(repGy);
      x.items = shown.map((gy) => ({ gy, rep: gy === repGy, cross: CROSS[track] ? CROSS[track].has(gy) : false }));
      x.rest = s.length - shown.length;
      x.cross = x.items.every((it) => it.cross);
      x.label = x.g + "군 " + shown.join("·") + (x.rest ? ` 외 ${x.rest}` : "");
    }
    // 트랙에 맞는 계열이 있는 군을 먼저(같으면 가·나·다 순)
    out.sort((a, b) => (a.cross ? 1 : 0) - (b.cross ? 1 : 0) || GUN.indexOf(a.g) - GUN.indexOf(b.g));
    return out;
  }
  const rowGys = (row) => gyLabel(row.chips.map((c) => c.gy));
  const rowGun = (row) => [...new Set(row.chips.map((c) => c.g))].sort((a, b) => GUN.indexOf(a) - GUN.indexOf(b)).join("·");

  return { BANDS, GUN, MED_KINDS, MIN_ROWS, FILL_GAP, medCapOf, build, groupsFor, say, sayRow, sayNow, SAY, SAY_REF, SAY_FILL, gyParts, gyLabel, chipGroups, rowGys, rowGun, trackOk, medKind, isMedGy };
});
