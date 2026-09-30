// xlcalc.js — 배치표 엑셀 수식을 그대로 평가하는 작은 인터프리터 (브라우저·node 겸용)
// 워크북 모델: { sheets: { [name]: { [addr]: {f: "=...", v: value} } } }  (addr 예: "AE8")
(function (root) {
  "use strict";
  // ── 값 타입 ──
  class XErr { constructor(code) { this.code = code; } toString() { return this.code; } }
  const E = { NA: new XErr("#N/A"), VALUE: new XErr("#VALUE!"), DIV0: new XErr("#DIV/0!"), REF: new XErr("#REF!"), NUM: new XErr("#NUM!"), NAME: new XErr("#NAME?") };
  const isErr = (x) => x instanceof XErr;
  class Ref { constructor(sheet, r1, c1, r2, c2) { this.sheet = sheet; this.r1 = r1; this.c1 = c1; this.r2 = r2 === undefined ? r1 : r2; this.c2 = c2 === undefined ? c1 : c2; } get single() { return this.r1 === this.r2 && this.c1 === this.c2; } }
  class Union { constructor(refs) { this.refs = refs; } }
  class XArray { constructor(items) { this.items = items; } }

  // ── 주소 유틸 ──
  function colNum(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
  function colStr(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  const addr = (r, c) => colStr(c) + r;

  // ── 토크나이저 ──
  function tokenize(src) {
    const t = []; let i = 0; const s = src;
    while (i < s.length) {
      const ch = s[i];
      if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") { i++; continue; }
      if (ch === '"') { let j = i + 1, str = ""; while (j < s.length) { if (s[j] === '"') { if (s[j + 1] === '"') { str += '"'; j += 2; continue; } break; } str += s[j++]; } t.push({ k: "str", v: str }); i = j + 1; continue; }
      if (ch === "'") { let j = i + 1, nm = ""; while (j < s.length) { if (s[j] === "'") { if (s[j + 1] === "'") { nm += "'"; j += 2; continue; } break; } nm += s[j++]; } i = j + 1; if (s[i] !== "!") throw new Error("quoted name without ! in " + src); i++; t.push({ k: "sheet", v: nm }); continue; }
      if (ch === "#") { const m = /^#(N\/A|VALUE!|DIV\/0!|REF!|NUM!|NAME\?|NULL!)/.exec(s.slice(i)); if (m) { t.push({ k: "err", v: m[0] }); i += m[0].length; continue; } }
      if (/[0-9.]/.test(ch)) { const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i)); t.push({ k: "num", v: parseFloat(m[0]) }); i += m[0].length; continue; }
      if (/[A-Za-z_$\u00C0-\uFFFF]/.test(ch)) {
        const m = /^[A-Za-z_$\u00C0-\uFFFF][A-Za-z0-9_.$\u00C0-\uFFFF]*/.exec(s.slice(i)); let w = m[0]; i += w.length;
        if (s[i] === "!") { i++; t.push({ k: "sheet", v: w }); continue; }
        if (s[i] === "(") { t.push({ k: "fn", v: w.toUpperCase().replace(/^_XLFN\./, "").replace(/^_XLWS\./, "") }); continue; }
        if (/^\$?[A-Z]{1,3}\$?\d+$/.test(w)) { t.push({ k: "cell", v: w.replace(/\$/g, "") }); continue; }
        if (/^\$?[A-Z]{1,3}$/.test(w) && s[i] === ":") { t.push({ k: "colref", v: w.replace(/\$/g, "") }); continue; }
        if (/^TRUE$/i.test(w)) { t.push({ k: "bool", v: true }); continue; }
        if (/^FALSE$/i.test(w)) { t.push({ k: "bool", v: false }); continue; }
        t.push({ k: "name", v: w }); continue;
      }
      const two = s.slice(i, i + 2);
      if (two === "<=" || two === ">=" || two === "<>") { t.push({ k: "op", v: two }); i += 2; continue; }
      if (ch === "{" || ch === "}" || ch === ";") { t.push({ k: ch, v: ch }); i++; continue; }
      if ("+-*/^&=<>%:(),".includes(ch)) { t.push({ k: ch === "(" || ch === ")" || ch === "," ? ch : "op", v: ch }); i++; continue; }
      throw new Error("tokenize: unexpected '" + ch + "' in " + src);
    }
    return t;
  }

  // ── 파서 (우선순위: : > 단항- > % > ^ > */ > +- > & > 비교) ──
  function parse(src) {
    const t = tokenize(src.startsWith("=") ? src.slice(1) : src); let p = 0;
    const peek = () => t[p], next = () => t[p++];
    const PREC = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };
    function expr(minP) {
      let lhs = unary();
      for (;;) {
        const tk = peek(); if (!tk || tk.k !== "op" || !(tk.v in PREC)) break;
        const pr = PREC[tk.v]; if (pr < minP) break; next();
        const rhs = expr(tk.v === "^" ? pr : pr + 1); lhs = { t: "bin", op: tk.v, a: lhs, b: rhs };
      }
      return lhs;
    }
    function unary() {
      const tk = peek();
      if (tk && tk.k === "op" && (tk.v === "-" || tk.v === "+")) { next(); const x = unary(); return tk.v === "-" ? { t: "neg", a: x } : x; }
      let x = postfix(primary());
      return x;
    }
    function postfix(x) { while (peek() && peek().k === "op" && peek().v === "%") { next(); x = { t: "pct", a: x }; } return x; }
    function refAfterSheet(sheet) {
      const tk = next();
      if (tk.k === "cell") return rangeTail({ t: "ref", sheet, a: tk.v });
      if (tk.k === "colref") return rangeTail({ t: "ref", sheet, a: tk.v });
      if (tk.k === "num") return rangeTail({ t: "ref", sheet, a: String(tk.v) });
      throw new Error("bad ref after sheet in " + src);
    }
    function rangeTail(node) {
      if (peek() && peek().k === "op" && peek().v === ":") {
        next(); const tk = next(); let b;
        if (tk.k === "cell" || tk.k === "colref" || tk.k === "name") b = tk.v.replace(/\$/g, ""); else if (tk.k === "num") b = String(tk.v); else if (tk.k === "sheet") { const n2 = next(); b = n2.v; } else throw new Error("bad range in " + src);
        node = { t: "ref", sheet: node.sheet, a: node.a, b };
      }
      return node;
    }
    function primary() {
      const tk = next();
      if (!tk) throw new Error("unexpected end in " + src);
      switch (tk.k) {
        case "num": return { t: "lit", v: tk.v };
        case "str": return { t: "lit", v: tk.v };
        case "bool": return { t: "lit", v: tk.v };
        case "err": return { t: "lit", v: new XErr(tk.v) };
        case "cell": case "colref": return rangeTail({ t: "ref", sheet: null, a: tk.v });
        case "sheet": return refAfterSheet(tk.v);
        case "fn": {
          next(); const args = [];
          if (peek().k === ")") { next(); return { t: "fn", n: tk.v, args }; }
          for (;;) {
            if (peek().k === "," ) { args.push({ t: "missing" }); next(); continue; }
            if (peek().k === ")") { args.push({ t: "missing" }); next(); break; }
            args.push(expr(1));
            const d = next(); if (d.k === ")") break; if (d.k !== ",") throw new Error("expected , or ) in " + src);
            if (peek().k === ")") { args.push({ t: "missing" }); next(); break; }
          }
          return { t: "fn", n: tk.v, args };
        }
        case "(": {
          const first = expr(1);
          if (peek().k === ",") { const items = [first]; while (peek().k === ",") { next(); items.push(expr(1)); } if (next().k !== ")") throw new Error("union ) in " + src); return { t: "union", items }; }
          if (next().k !== ")") throw new Error("expected ) in " + src); return first;
        }
        case "{": {
          const rows = [[]];
          for (;;) {
            const x = unary(); rows[rows.length - 1].push(x.t === "lit" ? x.v : x.t === "neg" && x.a.t === "lit" ? -x.a.v : (() => { throw new Error("bad array const in " + src); })());
            const d = next(); if (d.k === "}") break; if (d.k === ";") { rows.push([]); continue; } if (d.k !== ",") throw new Error("bad array sep in " + src);
          }
          return { t: "arr", v: rows.flat() };
        }
        case "name": throw new Error("unsupported name '" + tk.v + "' in " + src);
      }
      throw new Error("unexpected token " + JSON.stringify(tk) + " in " + src);
    }
    const ast = expr(1); if (p !== t.length) throw new Error("trailing tokens in " + src); return ast;
  }

  // ── 숫자 → 문자열 (엑셀 일반 서식 근사: 유효숫자 15자리) ──
  function numToStr(n) { if (Number.isInteger(n)) return String(n); let s = n.toPrecision(15); if (s.includes("e")) return String(Number(s)); s = s.replace(/\.?0+$/, ""); return s; }
  function round15(x) { return x === 0 ? 0 : Number(x.toPrecision(15)); }

  // ── 워크북 평가기 ──
  class Workbook {
    constructor(model, astCache) { this.m = model; this.cache = new Map(); this.inputs = new Map(); this.astCache = astCache || new Map(); this.stack = new Set(); }
    setInput(sheet, a, v) { this.inputs.set(sheet + "!" + a, v); }
    clearInputs() { this.inputs.clear(); }
    reset() { this.cache.clear(); }
    cellRaw(sheet, r, c) {
      const key = sheet + "!" + addr(r, c);
      if (this.inputs.has(key)) { const v = this.inputs.get(key); return v === "" ? null : v; }
      if (this.cache.has(key)) return this.cache.get(key);
      const sh = this.m.sheets[sheet]; if (!sh) return E.REF;
      const cell = sh[addr(r, c)];
      let v = null;
      if (cell) {
        if (cell.f) {
          if (this.stack.has(key)) throw new Error("circular at " + key);
          this.stack.add(key);
          try {
            let ast = this.astCache.get(key); if (!ast) { ast = parse(cell.f); this.astCache.set(key, ast); }
            v = this.scalar(this.ev(ast, sheet, r, c), r, c);
          } finally { this.stack.delete(key); }
          if (v === null) v = 0; // 수식 결과가 빈 참조면 0
        } else v = cell.v === undefined ? null : cell.v;
      }
      this.cache.set(key, v); return v;
    }
    get(sheet, a) { const m = /^([A-Z]+)(\d+)$/.exec(a); return this.cellRaw(sheet, +m[2], colNum(m[1])); }
    mkRef(node, sheet) {
      const sh = node.sheet || sheet;
      const pa = (a) => { const m = /^([A-Z]+)?(\d+)?$/.exec(a); return { c: m[1] ? colNum(m[1]) : null, r: m[2] ? +m[2] : null }; };
      const A = pa(node.a); if (!node.b) return new Ref(sh, A.r, A.c);
      const B = pa(node.b);
      const r1 = A.r === null ? 1 : A.r, r2 = B.r === null ? 1048576 : B.r, c1 = A.c === null ? 1 : A.c, c2 = B.c === null ? 16384 : B.c;
      return new Ref(sh, Math.min(r1, r2), Math.min(c1, c2), Math.max(r1, r2), Math.max(c1, c2));
    }
    // 평가: Ref/Union 또는 스칼라 반환
    ev(n, sheet, r, c) {
      switch (n.t) {
        case "lit": return n.v;
        case "arr": return new XArray(n.v.slice());
        case "missing": return null;
        case "ref": return this.mkRef(n, sheet);
        case "union": return new Union(n.items.map((x) => this.ev(x, sheet, r, c)).flatMap((x) => x instanceof Union ? x.refs : [x]));
        case "neg": { const v = this.num(this.ev(n.a, sheet, r, c), r, c); return isErr(v) ? v : -v; }
        case "pct": { const v = this.num(this.ev(n.a, sheet, r, c), r, c); return isErr(v) ? v : v / 100; }
        case "bin": return this.bin(n.op, this.scalar(this.ev(n.a, sheet, r, c), r, c), this.scalar(this.ev(n.b, sheet, r, c), r, c));
        case "fn": { const f = FN[n.n]; if (!f) throw new Error("unsupported function " + n.n); return f.call(this, n.args, sheet, r, c); }
      }
      throw new Error("bad node " + n.t);
    }
    // 스칼라화: 단일 셀 Ref → 값, 범위 → 암묵적 교차
    scalar(x, r, c) {
      if (x instanceof Ref) {
        if (x.single) return this.cellRaw(x.sheet, x.r1, x.c1);
        if (x.c1 === x.c2 && r >= x.r1 && r <= x.r2) return this.cellRaw(x.sheet, r, x.c1);
        if (x.r1 === x.r2 && c >= x.c1 && c <= x.c2) return this.cellRaw(x.sheet, x.r1, c);
        return E.VALUE;
      }
      if (x instanceof Union) return E.VALUE;
      return x;
    }
    num(x, r, c) {
      const v = this.scalar(x, r, c);
      if (v === null) return 0; if (typeof v === "number") return v; if (typeof v === "boolean") return v ? 1 : 0; if (isErr(v)) return v;
      if (typeof v === "string") { const s = v.trim(); if (s === "") return E.VALUE; const pct = /%$/.test(s); const n = Number(pct ? s.slice(0, -1) : s); return Number.isFinite(n) ? (pct ? n / 100 : n) : E.VALUE; }
      return E.VALUE;
    }
    str(x, r, c) { const v = this.scalar(x, r, c); if (v === null) return ""; if (typeof v === "number") return numToStr(v); if (typeof v === "boolean") return v ? "TRUE" : "FALSE"; return v; }
    bool(x, r, c) { const v = this.scalar(x, r, c); if (v === null) return false; if (typeof v === "boolean") return v; if (typeof v === "number") return v !== 0; if (isErr(v)) return v; if (typeof v === "string") { if (/^true$/i.test(v)) return true; if (/^false$/i.test(v)) return false; return E.VALUE; } return E.VALUE; }
    bin(op, a, b) {
      if (op === "&") { if (isErr(a)) return a; if (isErr(b)) return b; return this.str(a) + this.str(b); }
      if (["=", "<>", "<", ">", "<=", ">="].includes(op)) {
        if (isErr(a)) return a; if (isErr(b)) return b;
        const cmp = compare(a, b);
        return { "=": cmp === 0, "<>": cmp !== 0, "<": cmp < 0, ">": cmp > 0, "<=": cmp <= 0, ">=": cmp >= 0 }[op];
      }
      const x = this.num(a), y = this.num(b); if (isErr(x)) return x; if (isErr(y)) return y;
      switch (op) {
        case "+": return x + y; case "-": return x - y; case "*": return x * y;
        case "/": return y === 0 ? E.DIV0 : x / y; case "^": return Math.pow(x, y);
      }
      throw new Error("op " + op);
    }
    // 범위의 값 목록 (행 우선)
    values(x) {
      if (x instanceof Union) return x.refs.flatMap((rf) => this.values(rf));
      if (x instanceof XArray) return x.items.slice();
      if (x instanceof Ref) { const out = []; for (let rr = x.r1; rr <= x.r2; rr++) for (let cc = x.c1; cc <= x.c2; cc++) out.push(this.cellRaw(x.sheet, rr, cc)); return out; }
      return [x];
    }
  }
  // 엑셀 비교: 빈칸은 상대 타입의 기본값, 숫자<문자<논리, 문자 대소문자 무시
  function rank(v) { return typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : 3; }
  function compare(a, b) {
    if (a === null && b === null) return 0;
    if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
    if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
    const ra = rank(a), rb = rank(b); if (ra !== rb) return ra - rb;
    if (ra === 0) { const x = round15(a), y = round15(b); return x < y ? -1 : x > y ? 1 : 0; }
    if (ra === 1) { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  // 엑셀 ROUND: 0.5는 0에서 멀어지는 쪽, 유효숫자 15자리 보정
  function xround(x, d) {
    const s = x < 0 ? -1 : 1, ax = Math.abs(x); const f = Math.pow(10, d);
    const y = round15(ax * f); const out = s * Math.floor(y + 0.5) / f; return out === 0 ? 0 : out;
  }
  function xroundAway(x, d, up) { const s = x < 0 ? -1 : 1, f = Math.pow(10, d); const y = round15(Math.abs(x) * f); return s * (up ? Math.ceil(y) : Math.floor(y)) / f; }

  // 조건식 COUNTIF 류
  function critFn(wb, crit) {
    let op = "=", val = crit;
    if (typeof crit === "string") { const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(crit); op = m[1] || "="; val = m[2]; const n = Number(val); if (val !== "" && Number.isFinite(n)) val = n; }
    return (v) => {
      if (typeof val === "number") { if (typeof v !== "number") return op === "<>"; const c = compare(v, val); return { "=": c === 0, "<>": c !== 0, "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0 }[op]; }
      const sv = v === null ? "" : typeof v === "number" ? numToStr(v) : String(v);
      if (op === "=" || op === "<>") { const re = new RegExp("^" + String(val).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i"); const ok = re.test(sv) && !(v === null && val !== ""); return op === "=" ? ok : !ok; }
      const c = compare(sv, String(val)); return { "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0 }[op];
    };
  }

  const FN = {
    IF(a, s, r, c) { const cond = this.bool(this.ev(a[0], s, r, c), r, c); if (isErr(cond)) return cond; if (cond) return a.length > 1 ? (a[1].t === "missing" ? 0 : this.ev(a[1], s, r, c)) : true; return a.length > 2 ? (a[2].t === "missing" ? 0 : this.ev(a[2], s, r, c)) : false; },
    IFERROR(a, s, r, c) { const v = this.scalar(this.ev(a[0], s, r, c), r, c); return isErr(v) ? this.ev(a[1], s, r, c) : (v === null ? 0 : v); },
    IFNA(a, s, r, c) { const v = this.scalar(this.ev(a[0], s, r, c), r, c); return (isErr(v) && v.code === "#N/A") ? this.ev(a[1], s, r, c) : v; },
    ISERROR(a, s, r, c) { return isErr(this.scalar(this.ev(a[0], s, r, c), r, c)); },
    ISNUMBER(a, s, r, c) { return typeof this.scalar(this.ev(a[0], s, r, c), r, c) === "number"; },
    ISBLANK(a, s, r, c) { return this.scalar(this.ev(a[0], s, r, c), r, c) === null; },
    AND(a, s, r, c) { let res = true; for (const x of a) { for (const v of this.values(this.ev(x, s, r, c))) { if (v === null || typeof v === "string") continue; const b = this.bool(v); if (isErr(b)) return b; res = res && b; } } return res; },
    OR(a, s, r, c) { let res = false; for (const x of a) { for (const v of this.values(this.ev(x, s, r, c))) { if (v === null || typeof v === "string") continue; const b = this.bool(v); if (isErr(b)) return b; res = res || b; } } return res; },
    NOT(a, s, r, c) { const b = this.bool(this.ev(a[0], s, r, c), r, c); return isErr(b) ? b : !b; },
    ROW(a, s, r, c) { if (!a.length || a[0].t === "missing") return r; const x = this.ev(a[0], s, r, c); return x.r1; },
    COLUMN(a, s, r, c) { if (!a.length || a[0].t === "missing") return c; const x = this.ev(a[0], s, r, c); return x.c1; },
    OFFSET(a, s, r, c) {
      const base = this.ev(a[0], s, r, c); if (!(base instanceof Ref)) return E.VALUE;
      const dr = this.num(this.ev(a[1], s, r, c), r, c), dc = this.num(this.ev(a[2], s, r, c), r, c); if (isErr(dr)) return dr; if (isErr(dc)) return dc;
      const h = a[3] && a[3].t !== "missing" ? this.num(this.ev(a[3], s, r, c), r, c) : base.r2 - base.r1 + 1;
      const w = a[4] && a[4].t !== "missing" ? this.num(this.ev(a[4], s, r, c), r, c) : base.c2 - base.c1 + 1;
      if (isErr(h)) return h; if (isErr(w)) return w;
      const r1 = base.r1 + Math.trunc(dr), c1 = base.c1 + Math.trunc(dc);
      if (r1 < 1 || c1 < 1 || h < 1 || w < 1) return E.REF;
      return new Ref(base.sheet, r1, c1, r1 + Math.trunc(h) - 1, c1 + Math.trunc(w) - 1);
    },
    INDEX(a, s, r, c) {
      let rng = this.ev(a[0], s, r, c); if (rng instanceof Union) { const k = a[3] ? this.num(this.ev(a[3], s, r, c)) : 1; rng = rng.refs[k - 1]; }
      if (!(rng instanceof Ref)) return E.VALUE;
      let ri = a[1] && a[1].t !== "missing" ? this.num(this.ev(a[1], s, r, c), r, c) : 0; let ci = a[2] && a[2].t !== "missing" ? this.num(this.ev(a[2], s, r, c), r, c) : 0;
      if (isErr(ri)) return ri; if (isErr(ci)) return ci; ri = Math.trunc(ri); ci = Math.trunc(ci);
      const nr = rng.r2 - rng.r1 + 1, nc = rng.c2 - rng.c1 + 1;
      if (nr === 1 && a.length === 2) { ci = ri; ri = 1; }
      if (ri < 0 || ci < 0 || ri > nr || ci > nc) return E.REF;
      if (ri === 0 && ci === 0) return rng;
      if (ri === 0) return new Ref(rng.sheet, rng.r1, rng.c1 + ci - 1, rng.r2, rng.c1 + ci - 1);
      if (ci === 0) { if (nc === 1) return new Ref(rng.sheet, rng.r1 + ri - 1, rng.c1); return new Ref(rng.sheet, rng.r1 + ri - 1, rng.c1, rng.r1 + ri - 1, rng.c2); }
      return new Ref(rng.sheet, rng.r1 + ri - 1, rng.c1 + ci - 1);
    },
    MATCH(a, s, r, c) {
      const look = this.scalar(this.ev(a[0], s, r, c), r, c); if (isErr(look)) return look;
      const vals = this.values(this.ev(a[1], s, r, c));
      const type = a[2] && a[2].t !== "missing" ? this.num(this.ev(a[2], s, r, c), r, c) : 1;
      const lk = look === null ? 0 : look;
      if (type === 0) {
        if (typeof lk === "string") { const re = new RegExp("^" + lk.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/~\*/g, "\u0001").replace(/\*/g, ".*").replace(/\?/g, ".").replace(/\u0001/g, "\\*") + "$", "i"); for (let i = 0; i < vals.length; i++) if (typeof vals[i] === "string" && re.test(vals[i])) return i + 1; return E.NA; }
        for (let i = 0; i < vals.length; i++) { const v = vals[i]; if (v !== null && rank(v) === rank(lk) && compare(v, lk) === 0) return i + 1; } return E.NA;
      }
      // 근사 일치: 이진 탐색(엑셀 동작) — 같은 타입만 비교
      let lo = 0, hi = vals.length - 1, best = -1;
      const ok = (v) => v !== null && rank(v) === rank(lk);
      if (type > 0) {
        while (lo <= hi) { let mid = (lo + hi) >> 1; let m2 = mid; while (m2 >= lo && !ok(vals[m2])) m2--; if (m2 < lo) { lo = mid + 1; continue; } if (compare(vals[m2], lk) <= 0) { best = m2; lo = mid + 1; } else hi = m2 - 1; }
      } else {
        while (lo <= hi) { let mid = (lo + hi) >> 1; let m2 = mid; while (m2 >= lo && !ok(vals[m2])) m2--; if (m2 < lo) { lo = mid + 1; continue; } if (compare(vals[m2], lk) >= 0) { best = m2; lo = mid + 1; } else hi = m2 - 1; }
      }
      return best < 0 ? E.NA : best + 1;
    },
    VLOOKUP(a, s, r, c) {
      const look = this.scalar(this.ev(a[0], s, r, c), r, c); if (isErr(look)) return look;
      const rng = this.ev(a[1], s, r, c); const col = this.num(this.ev(a[2], s, r, c), r, c); const exact = a[3] && a[3].t !== "missing" ? !this.bool(this.ev(a[3], s, r, c), r, c) : false;
      const first = new Ref(rng.sheet, rng.r1, rng.c1, rng.r2, rng.c1);
      const m = FN.MATCH.call(this, [{ t: "lit", v: look }, { t: "_ref", ref: first }, { t: "lit", v: exact ? 0 : 1 }], s, r, c);
      if (isErr(m)) return m; return this.cellRaw(rng.sheet, rng.r1 + m - 1, rng.c1 + col - 1);
    },
    LARGE(a, s, r, c) { const kx = this.ev(a[1], s, r, c); if (kx instanceof XArray) { const v = this.nums(this.ev(a[0], s, r, c)); if (isErr(v)) return v; v.sort((x, y) => y - x); return new XArray(kx.items.map((k) => (k < 1 || k > v.length) ? E.NUM : v[Math.ceil(k) - 1])); } const k = this.num(kx, r, c); if (isErr(k)) return k; const v = this.nums(this.ev(a[0], s, r, c)); if (isErr(v)) return v; v.sort((x, y) => y - x); return (k < 1 || k > v.length) ? E.NUM : v[Math.ceil(k) - 1]; },
    SMALL(a, s, r, c) { const k = this.num(this.ev(a[1], s, r, c), r, c); if (isErr(k)) return k; const v = this.nums(this.ev(a[0], s, r, c)); if (isErr(v)) return v; v.sort((x, y) => x - y); return (k < 1 || k > v.length) ? E.NUM : v[Math.ceil(k) - 1]; },
    MAX(a, s, r, c) { const v = this.numsArgs(a, s, r, c); if (isErr(v)) return v; return v.length ? Math.max(...v) : 0; },
    MIN(a, s, r, c) { const v = this.numsArgs(a, s, r, c); if (isErr(v)) return v; return v.length ? Math.min(...v) : 0; },
    SUM(a, s, r, c) { const v = this.numsArgs(a, s, r, c); if (isErr(v)) return v; return v.reduce((x, y) => x + y, 0); },
    AVERAGE(a, s, r, c) { const v = this.numsArgs(a, s, r, c); if (isErr(v)) return v; return v.length ? v.reduce((x, y) => x + y, 0) / v.length : E.DIV0; },
    COUNT(a, s, r, c) { let n = 0; for (const x of a) for (const v of this.values(this.ev(x, s, r, c))) if (typeof v === "number") n++; return n; },
    COUNTA(a, s, r, c) { let n = 0; for (const x of a) for (const v of this.values(this.ev(x, s, r, c))) if (v !== null) n++; return n; },
    COUNTIF(a, s, r, c) { const crit = this.scalar(this.ev(a[1], s, r, c), r, c); const f = critFn(this, crit); let n = 0; for (const v of this.values(this.ev(a[0], s, r, c))) if (f(v)) n++; return n; },
    SUMIF(a, s, r, c) { const rng = this.ev(a[0], s, r, c); const crit = this.scalar(this.ev(a[1], s, r, c), r, c); const f = critFn(this, crit); const vs = this.values(rng); const ss = a[2] ? this.values(this.ev(a[2], s, r, c)) : vs; let t = 0; vs.forEach((v, i) => { if (f(v) && typeof ss[i] === "number") t += ss[i]; }); return t; },
    ROUND(a, s, r, c) { const x = this.num(this.ev(a[0], s, r, c), r, c), d = this.num(this.ev(a[1], s, r, c), r, c); if (isErr(x)) return x; if (isErr(d)) return d; return xround(x, Math.trunc(d)); },
    ROUNDUP(a, s, r, c) { const x = this.num(this.ev(a[0], s, r, c), r, c), d = this.num(this.ev(a[1], s, r, c), r, c); if (isErr(x)) return x; if (isErr(d)) return d; return xroundAway(x, Math.trunc(d), true); },
    ROUNDDOWN(a, s, r, c) { const x = this.num(this.ev(a[0], s, r, c), r, c), d = this.num(this.ev(a[1], s, r, c), r, c); if (isErr(x)) return x; if (isErr(d)) return d; return xroundAway(x, Math.trunc(d), false); },
    TRUNC(a, s, r, c) { const x = this.num(this.ev(a[0], s, r, c), r, c); const d = a[1] ? this.num(this.ev(a[1], s, r, c), r, c) : 0; if (isErr(x)) return x; return xroundAway(x, d, false); },
    INT(a, s, r, c) { const x = this.num(this.ev(a[0], s, r, c), r, c); return isErr(x) ? x : Math.floor(round15(x)); },
    ABS(a, s, r, c) { const x = this.num(this.ev(a[0], s, r, c), r, c); return isErr(x) ? x : Math.abs(x); },
    LEFT(a, s, r, c) { const t = this.scalar(this.ev(a[0], s, r, c), r, c); if (isErr(t)) return t; const n = a[1] ? this.num(this.ev(a[1], s, r, c), r, c) : 1; return this.str(t).slice(0, n); },
    RIGHT(a, s, r, c) { const t = this.scalar(this.ev(a[0], s, r, c), r, c); if (isErr(t)) return t; const n = a[1] ? this.num(this.ev(a[1], s, r, c), r, c) : 1; const st = this.str(t); return n === 0 ? "" : st.slice(-n); },
    MID(a, s, r, c) { const t = this.str(this.ev(a[0], s, r, c), r, c); const st = this.num(this.ev(a[1], s, r, c), r, c), n = this.num(this.ev(a[2], s, r, c), r, c); return t.substr(st - 1, n); },
    LEN(a, s, r, c) { const t = this.scalar(this.ev(a[0], s, r, c), r, c); if (isErr(t)) return t; return this.str(t).length; },
    VALUE(a, s, r, c) { return this.num(this.ev(a[0], s, r, c), r, c); },
    CONCAT(a, s, r, c) { let out = ""; for (const x of a) for (const v of this.values(this.ev(x, s, r, c))) { if (isErr(v)) return v; out += this.str(v); } return out; },
    CONCATENATE(a, s, r, c) { let out = ""; for (const x of a) { const v = this.scalar(this.ev(x, s, r, c), r, c); if (isErr(v)) return v; out += this.str(v); } return out; },
    CHOOSE(a, s, r, c) {
      const ix = this.ev(a[0], s, r, c);
      if (ix instanceof XArray) return new XArray(ix.items.map((k) => { const v = this.scalar(this.ev(a[Math.trunc(k)], s, r, c), r, c); return v === null ? 0 : v; }));
      const k = this.num(ix, r, c); if (isErr(k)) return k; if (k < 1 || k >= a.length) return E.VALUE; return this.ev(a[Math.trunc(k)], s, r, c);
    },
    RANK(a, s, r, c) { const x = this.num(this.ev(a[0], s, r, c), r, c); if (isErr(x)) return x; const v = this.nums(this.ev(a[1], s, r, c)); const asc = a[2] && a[2].t !== "missing" ? this.num(this.ev(a[2], s, r, c), r, c) : 0; if (!v.some((y) => compare(y, x) === 0)) return E.NA; return 1 + v.filter((y) => asc ? y < x : y > x).length; },
  };
  FN["RANK.EQ"] = FN.RANK;
  // 범위 내 숫자만 (텍스트·빈칸 무시), 오류 전파
  Workbook.prototype.nums = function (x) { const out = []; for (const v of this.values(x)) { if (isErr(v)) return v; if (typeof v === "number") out.push(v); } return out; };
  Workbook.prototype.numsArgs = function (args, s, r, c) {
    const out = [];
    for (const a of args) {
      const x = this.ev(a, s, r, c);
      if (x instanceof Ref || x instanceof Union || x instanceof XArray) { const v = this.nums(x); if (isErr(v)) return v; out.push(...v); }
      else { const v = this.num(x, r, c); if (isErr(v)) return v; out.push(v); }
    }
    return out;
  };
  // VLOOKUP 내부용 리터럴 참조 노드
  const _ev = Workbook.prototype.ev;
  Workbook.prototype.ev = function (n, s, r, c) { if (n.t === "_ref") return n.ref; return _ev.call(this, n, s, r, c); };

  const api = { Workbook, parse, tokenize, XErr, isErr, colNum, colStr, addr, xround, numToStr, FUNCTIONS: Object.keys(FN) };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.XLCalc = api;
})(typeof self !== "undefined" ? self : this);
