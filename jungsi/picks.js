// 스누코치 정시 배치 계산기 — 상향·소신·적정 대학 목록 고르기 (DOM 없는 순수 함수)
// 판정(worker.js 결과: 원자료 학과 rows + 추가 모집단위 extra)을 (대학, 군, 계열) 묶음으로 모으고, 구간마다 대학 행을 고른다.
// 학과명은 쓰지 않는다(묶음 단위로만 보여 줌). 브라우저: window.JungsiPicks / node: require("./picks.js")
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JungsiPicks = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  // ads 배열 순서 = 구간 안 우선순위(앞일수록 먼저 고름)
  const BANDS = [
    { key: "up", ads: [4, 5] },
    { key: "mid", ads: [3] },
    { key: "safe", ads: [2, 1] },
  ];
  const GUN = ["가", "나", "다"];
  const MED_CAP = 2; // 한 구간에 의약 전용 행 최대 수(의약이 아닌 후보가 모자라면 MIN_ROWS까지만 더 허용)
  const MIN_ROWS = 8; // 구간마다 이만큼은 채우려는 목표(후보가 없으면 가능한 만큼). 단순 비교 행은 이 수를 못 채울 때만 넣음
  const GUN_MIN = 2; // 후보에 있는 군은 선택 행 중 최소 이만큼(후보가 적으면 가능한 만큼)
  const GOAL_BONUS = 0.5; // 목표 시나리오에서 지금보다 판정이 오른 행의 정렬 가산점(서열값 lv 단위)
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

  // 4단계: 우선순위대로 고르되 의약 전용 행 한도와 군 균형을 맞춘다
  function select(cands, max) {
    const sel = []; let medN = 0;
    const nonMedAll = cands.filter((r) => !r.med).length;
    const cap = Math.max(MED_CAP, Math.min(max, MIN_ROWS) - nonMedAll); // 의약이 아닌 후보만으로 MIN_ROWS를 못 채우면 의약 전용 행으로 채움
    for (const r of cands) {
      if (sel.length >= max) break;
      if (r.med && medN >= cap) continue;
      sel.push(r); if (r.med) medN++;
    }
    const inSel = new Set(sel);
    const need = {};
    for (const g of GUN) {
      const withG = cands.filter((r) => hasGun(r, g));
      const nonMed = withG.filter((r) => !r.med).length, med = withG.length - nonMed;
      need[g] = Math.min(GUN_MIN, nonMed + Math.min(cap, med), max);
    }
    const cnt = (g) => sel.reduce((k, r) => k + (hasGun(r, g) ? 1 : 0), 0);
    for (let pass = 0; pass < 2; pass++) {
      for (const g of GUN) {
        while (cnt(g) < need[g]) {
          const next = cands.find((r) => !inSel.has(r) && hasGun(r, g) && (!r.med || medN < cap));
          if (!next) break;
          if (sel.length < max) { sel.push(next); inSel.add(next); if (next.med) medN++; continue; }
          // 뒤쪽(우선순위 낮은) 행부터, 빼도 다른 군 최소치가 깨지지 않는 행과 교체
          let vi = -1;
          for (let k = sel.length - 1; k >= 0; k--) {
            const v = sel[k]; if (hasGun(v, g)) continue;
            if (GUN.every((h) => h === g || !hasGun(v, h) || cnt(h) - 1 >= need[h])) { vi = k; break; }
          }
          if (vi < 0) break;
          const [out] = sel.splice(vi, 1); inSel.delete(out); if (out.med) medN--;
          sel.push(next); inSel.add(next); if (next.med) medN++;
        }
      }
    }
    return sel;
  }

  // 목록에서 빼야 하면 true: (가) 환산점수 역행 식만으로 판정한 묶음의 상향·소신 (나) 원본 기준점 묶음의 공통척도 점검
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

  // 대학 행 만들기: 같은 대학의 묶음(칩)을 한 행으로, 대표 칩 = 구간 안 우선순위가 가장 앞선 칩(같으면 lv 높은 칩)
  // 대표 칩·서열은 학생 트랙에 맞는 계열 칩에서 먼저 고른다(인문 학생 행의 대표가 공학·보건이 되지 않게). 트랙에 맞는 칩이 없는 행(cross)은 뒤로
  function finalize(byU, b, track) {
    const rows = [...byU.values()];
    const cross = CROSS[track] || CROSS.all;
    for (const row of rows) {
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
        const a = b.ads.indexOf(c.ad), z = b.ads.indexOf(row.chips[rc].ad);
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
    }
    rows.sort((x, y) => (x.cross ? 1 : 0) - (y.cross ? 1 : 0) || b.ads.indexOf(x.best) - b.ads.indexOf(y.best) || y.sk - x.sk || (x.u < y.u ? -1 : x.u > y.u ? 1 : 0));
    return rows;
  }
  // 표시 순서: 의약이 아닌 행 → 의약 전용 행, 그 안에서 트랙에 맞는 행 → 교차 계열만 있는 행, 각각 lv 내림차순
  const showOrder = (b) => (x, y) => (x.med ? 1 : 0) - (y.med ? 1 : 0) || (x.cross ? 1 : 0) - (y.cross ? 1 : 0) || y.lv - x.lv
    || b.ads.indexOf(x.best) - b.ads.indexOf(y.best) || (x.u < y.u ? -1 : x.u > y.u ? 1 : 0);

  /**
   * build(D, res, other, opt)
   *  D: depts.json 배열, res: worker 결과 {rows, extra}(또는 rows 배열) — 행 {ok,q,ad,p,ref,x}
   *  other: 목표 시나리오일 때 '지금 성적' 결과(없으면 null)
   *  opt: {track:'all'|'자연'|'통합', max:10, data:{lines, extra}, me: 국·수·탐 표준점수 합, eng: 영어 등급(1~9)}
   *  → { up:[row], mid:[row], safe:[row], counts:{up:{cand,shown,drop,candF,pct},…}, track }
   *  row: {u, band, chips:[{g,gy,ad,ref,pct,i,j,n,lv,med,o,lk}], rc(대표 칩 번호), best, ref, pct, lk, lv, med, o}
   *  chip.o(목표 시나리오일 때): '지금 성적'에서 같은 (대학, 군, 계열) 묶음의 판정 {ad, ref, ok} — 지금 목록과 같은 계산
   *  선택: 환산식 행(원자료·빌린 식)에서 먼저 최대 max개, MIN_ROWS에 못 미치면 단순 비교 행(pct)으로 MIN_ROWS까지 채움(이미 나온 대학은 빼고)
   *  표시 순서: 의약이 아닌 행 먼저, 그다음 의약 전용 행. 각각 lv 내림차순.
   */
  function build(D, res, other, opt) {
    opt = opt || {};
    const max = opt.max || 10;
    const track = opt.track || "all";
    const gopt = { track, data: opt.data };
    const { gs, gsO } = groupsFor(D, res, other, gopt);
    const me = typeof opt.me === "number" && opt.me > 0 ? opt.me : null;
    const eng = typeof opt.eng === "number" && opt.eng >= 1 ? opt.eng : 1;
    const out = { counts: {}, track };
    for (const b of BANDS) {
      const byF = new Map(), byP = new Map(); let drop = 0;
      for (const G of gs) {
        if (!b.ads.includes(G.ad)) continue;
        if (mismatch(b.key, G, me, eng)) { drop++; continue; }
        let o = null;
        if (gsO) { const Gn = gsO.get(G.key); o = Gn ? { ad: Gn.ad, ref: Gn.ref, ok: true } : { ad: null, ref: 0, ok: false }; }
        const rep = G.rep;
        const chip = { g: G.g, gy: G.gy, ad: G.ad, ref: G.ref, pct: G.pct, i: rep.src === "d" ? rep.i : null, j: rep.src === "x" ? rep.j : null,
          n: G.n, lv: G.lv, med: G.med, o, lk: G.lk };
        const M = G.pct ? byP : byF;
        let row = M.get(G.u);
        if (!row) M.set(G.u, (row = { u: G.u, band: b.key, chips: [] }));
        row.chips.push(chip);
      }
      const rowsF = finalize(byF, b, track), rowsP = finalize(byP, b, track);
      let sel = select(rowsF, max), fill = [];
      if (sel.length < Math.min(max, MIN_ROWS)) {
        const inSel = new Set(sel.map((r) => r.u));
        fill = select(rowsP.filter((r) => !inSel.has(r.u)), Math.min(max, MIN_ROWS) - sel.length);
        sel = sel.concat(fill);
      }
      sel.sort(showOrder(b));
      sel.forEach((r) => delete r.sk);
      out[b.key] = sel;
      const cand = new Set(rowsF.map((r) => r.u).concat(rowsP.map((r) => r.u))).size;
      out.counts[b.key] = { cand, shown: sel.length, drop, candF: rowsF.length, pct: fill.length };
    }
    return out;
  }

  // ── 판정 문구(확률 숫자는 쓰지 않음). ref=1(참고 판정)은 네 단계만 ──
  const SAY = { 1: "여유 있어요", 2: "무난해요", 3: "해 볼 만해요", 4: "도전해 볼 만해요", 5: "쉽지 않아요", 6: "어려워요" };
  const SAY_REF = { 1: "무난해요", 2: "무난해요", 3: "해 볼 만해요", 4: "도전 구간이에요", 5: "도전 구간이에요", 6: "어려워요" };
  function say(ad, ref, ok) {
    if (ok === false) return "응시 조건 확인";
    return (ref ? SAY_REF : SAY)[ad] || "-";
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

  return { BANDS, GUN, MED_KINDS, build, groupsFor, say, SAY, SAY_REF, gyParts, gyLabel, chipGroups, rowGys, rowGun, trackOk, medKind, isMedGy };
});
