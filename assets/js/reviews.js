// 스누코치 후기 페이지 — 「회원 후기」 구역
// 목록은 Supabase 라이브러리 없이 공개 조회(REST)로 읽는다. 로그인 흔적이 있을 때만 회원 기능(auth.js)을 불러온다.
// DB 구조와 권한: supabase/migrations/20261003000000_reviews.sql
// 화면에 넣는 글자는 전부 textContent 로 넣는다(innerHTML 을 쓰지 않는다).
(function () {
  "use strict";
  const CFG = window.SNUCOACH_AUTH || {};
  const sec = document.getElementById("member-reviews");
  if (!sec || !CFG.url || !CFG.key) return;

  const PAGE_SIZE = 10;
  const FIELDS = "id,rating,program,body,author,verified,created_at,updated_at";
  const PROGRAMS = ["학습코칭", "생기부 컨설팅", "무료 자료·이벤트", "기타"]; // DB 의 reviews_program_allowed 와 같아야 함
  const BODY_MIN = 10;
  const BODY_MAX = 1000;
  const KAKAO = "https://pf.kakao.com/_wiwxmG/chat";
  const LOGIN_URL = "login.html?next=reviews.html%23member-reviews";
  const RETURN_KEY = "snucoach-return"; // 구글·카카오 로그인 뒤 이 화면으로 돌아오기(auth.js 의 pageAccount 가 읽는다)
  const STAR_PATH = "M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z";
  const $ = (id) => document.getElementById(id);
  const tryDo = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

  // ── 순수 함수(시작). DB 의 private.review_clean_body 와 같은 규칙이다(둘을 함께 고친다).
  //    supabase/local/reviews-db.mjs 가 이 구간을 그대로 잘라 SQL 결과와 비교한다.
  // 본문 정리: 줄바꿈 통일 → 제어 문자·특수 공백은 공백으로 → 보이지 않는 글자 삭제 → 3개 이상 겹친 결합 기호 삭제
  //            → 빈 줄은 한 줄까지 → 앞뒤 공백·줄바꿈 삭제. 보이지 않는 글자는 반드시 \u 이스케이프로 적는다.
  const cleanBody = (v) => String(v == null ? "" : v)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u2800\u3000]/g, " ")
    .replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]/g, "")
    .replace(/[\u{E0000}-\u{E0FFF}]/gu, "")
    .replace(/[\u0300-\u036F\u0483-\u0489\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]{3,}/g, "")
    .replace(/\n[ \n]*\n/g, "\n\n")
    .replace(/^[ \n]+|[ \n]+$/g, "");
  // 글자 수: DB 의 char_length 와 같게 코드 포인트로 센다(이모지 1개 = 1자).
  const bodyLength = (v) => Array.from(cleanBody(v)).length;
  // ── 순수 함수(끝) ──

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const show = (node, on = true) => { if (node) node.hidden = !on; };
  const fmtDate = (iso) => new Intl.DateTimeFormat("ko-KR", { dateStyle: "long", timeZone: "Asia/Seoul" }).format(new Date(iso));
  const num = (n) => Number(n).toLocaleString("ko-KR");
  function msg(node, text, kind = "error") {
    node.className = `auth-msg is-${kind}`;
    node.textContent = text || "";
    node.hidden = !text;
  }
  async function busy(btn, label, fn) {
    const old = Array.from(btn.childNodes);
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.textContent = label;
    try { return await fn(); } finally {
      btn.replaceChildren(...old);
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
  }
  function star(on) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (on) svg.setAttribute("class", "on");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", STAR_PATH);
    svg.append(p);
    return svg;
  }

  const els = {
    total: $("mrvTotal"), write: $("mrvWrite"), msg: $("mrvMsg"), jump: $("mrvJump"), stat: $("mrvHiddenStat"),
    form: $("mrvForm"), formTitle: $("mrvFormTitle"), program: $("mrvProgram"), programErr: $("mrvProgramErr"), programNote: $("mrvProgramNote"),
    rate: $("mrvRate"), rateText: $("mrvRateText"), rateErr: $("mrvRateErr"),
    body: $("mrvBody"), bodyCount: $("mrvBodyCount"), bodyErr: $("mrvBodyErr"), preview: $("mrvAuthorPreview"),
    formMsg: $("mrvFormMsg"), submit: $("mrvSubmit"), cancel: $("mrvCancel"),
    mine: $("mrvMine"), mineList: $("mrvMineList"), list: $("mrvList"), empty: $("mrvEmpty"), more: $("mrvMore"), status: $("mrvStatus"),
  };
  const radios = Array.from(els.rate.querySelectorAll('input[name="rating"]'));
  const framed = window.top !== window.self; // 다른 사이트의 프레임 안에서는 목록만 보여 준다(클릭재킹 방지)

  let api = null;      // auth.js 가 내놓는 회원 후기 도구(로그인한 경우에만)
  let state = null;    // 쓰기 영역 상태
  let author = "";     // 지금 쓰면 붙는 표시 이름(예: 김**)
  let shown = [];      // 지금 그려 둔 공개 후기
  let mine = [];       // 내가 쓴 후기(숨김 처리된 글 포함)
  let editing = null;  // 고치는 중인 후기(새 글이면 null)
  let hasMore = false;

  // ── 공개 조회: 라이브러리 없이 REST 로 읽는다 ──
  async function rest(path, headers) {
    const res = await fetch(`${String(CFG.url).replace(/\/+$/, "")}/rest/v1/${path}`, {
      headers: Object.assign({ apikey: CFG.key, Accept: "application/json" }, headers || {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(err.message || String(res.status)), { code: err.code, status: res.status });
    }
    return res;
  }
  async function fetchPage(beforeId, withCount) {
    const q = `select=${FIELDS}&order=id.desc&limit=${PAGE_SIZE + 1}` + (beforeId ? `&id=lt.${Number(beforeId)}` : "");
    const res = await rest(`reviews_public?${q}`, withCount ? { Prefer: "count=exact" } : null);
    const count = withCount ? Number((res.headers.get("Content-Range") || "").split("/")[1]) : NaN;
    const rows = await res.json();
    return { rows: Array.isArray(rows) ? rows : [], total: Number.isFinite(count) ? count : null };
  }
  const notReady = (e) => !!e && (e.code === "PGRST205" || e.code === "42P01" || e.status === 404);

  // ── 카드 ──
  function head(r, own) {
    const h = el("div", "mrv-item-head");
    const stars = el("span", "mrv-stars");
    const rating = Math.min(5, Math.max(0, Number(r.rating) || 0));
    stars.setAttribute("role", "img");
    stars.setAttribute("aria-label", `별점 5점 만점에 ${rating}점`);
    for (let i = 1; i <= 5; i += 1) stars.append(star(i <= rating));
    h.append(stars, el("span", "badge", r.program));
    if (r.verified) h.append(el("span", "badge gold", "수강 확인"));
    if (own) h.append(el("span", "badge", "내 후기"));
    return h;
  }
  function bodyBlock(r) {
    const wrap = document.createDocumentFragment();
    const p = el("p", "mrv-body is-clamped", r.body);
    p.id = `mrv-body-${r.id}-${Math.random().toString(36).slice(2, 7)}`;
    wrap.append(p);
    return wrap;
  }
  function meta(r) {
    const m = el("p", "mrv-meta");
    const t = el("time", null, fmtDate(r.created_at));
    t.dateTime = r.created_at;
    m.append(el("span", "mrv-author", r.author), " · ", t);
    if (r.updated_at && r.created_at && new Date(r.updated_at).getTime() !== new Date(r.created_at).getTime()) m.append(" · 수정됨");
    return m;
  }
  // 긴 본문·줄바꿈이 많은 본문은 12줄까지만 보이고 「더 보기」로 편다(구역이 화면에 보인 뒤에 잰다)
  function fitBodies(root) {
    if (sec.hidden) return;
    root.querySelectorAll(".mrv-body.is-clamped:not([data-fit])").forEach((p) => {
      p.dataset.fit = "1";
      if (p.scrollHeight <= p.clientHeight + 2) { p.classList.remove("is-clamped"); return; }
      const b = el("button", "text-btn mrv-toggle", "더 보기");
      b.type = "button";
      b.setAttribute("aria-expanded", "false");
      b.setAttribute("aria-controls", p.id);
      b.addEventListener("click", () => {
        const open = p.classList.toggle("is-clamped") === false;
        b.setAttribute("aria-expanded", String(open));
        b.textContent = open ? "접기" : "더 보기";
      });
      p.after(b);
    });
  }
  function publicItem(r, ownIds) {
    const li = el("li", "mrv-item");
    li.id = `mrv-${r.id}`;
    li.tabIndex = -1;
    li.append(head(r, ownIds.has(r.id)), bodyBlock(r), meta(r));
    return li;
  }
  function drawList(focusId) {
    const ownIds = new Set(mine.map((m) => m.id));
    els.list.replaceChildren(...shown.map((r) => publicItem(r, ownIds)));
    show(els.empty, !shown.length);
    show(els.more, hasMore);
    fitBodies(els.list);
    if (focusId) { const first = $(`mrv-${focusId}`); if (first) first.focus(); }
  }
  function setTotal(total) {
    els.total.textContent = total == null ? "" : `${num(total)}건`;
  }

  async function loadFirst() {
    const page = await fetchPage(null, true);
    hasMore = page.rows.length > PAGE_SIZE;
    shown = page.rows.slice(0, PAGE_SIZE);
    setTotal(page.total);
    drawList();
  }
  async function loadMore() {
    const last = shown[shown.length - 1];
    if (!last) return;
    await busy(els.more, "불러오는 중…", async () => {
      try {
        const page = await fetchPage(last.id, false);
        const add = page.rows.slice(0, PAGE_SIZE);
        hasMore = page.rows.length > PAGE_SIZE;
        shown = shown.concat(add);
        drawList(add.length ? add[0].id : null);
        els.status.textContent = add.length ? `후기 ${add.length}건을 더 불러왔습니다.` : "더 불러올 후기가 없습니다.";
      } catch (e) {
        els.status.textContent = "";
        msg(els.msg, "후기를 더 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      }
    });
    show(els.more, hasMore);
  }

  // 숨김 처리 현황(사유별 건수). 운영 기준 안내에 적는다.
  async function loadStat() {
    if (!els.stat) return;
    try {
      const rows = await (await rest("rpc/review_hidden_stats")).json();
      const list = (Array.isArray(rows) ? rows : []).filter((x) => x && Number(x.n) > 0);
      const sum = list.reduce((a, x) => a + Number(x.n), 0);
      els.stat.textContent = sum
        ? `지금 운영 기준에 따라 숨김 처리된 후기는 ${num(sum)}건입니다(${list.map((x) => `${x.reason} ${num(x.n)}건`).join(", ")}).`
        : "지금 숨김 처리된 후기는 없습니다.";
    } catch (e) {
      els.stat.textContent = "숨김 처리 현황을 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.";
    }
  }

  function failList() {
    msg(els.msg, "후기를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
    const actions = el("div", "msg-actions");
    const b = el("button", "btn btn-line btn-sm", "다시 시도");
    b.type = "button";
    b.addEventListener("click", () => busy(b, "불러오는 중…", async () => {
      try { await loadFirst(); msg(els.msg, ""); loadStat(); } catch (e) { /* 안내를 그대로 둔다 */ }
    }));
    actions.append(b);
    els.msg.append(actions);
  }

  // ── 회원 기능: 로그인 흔적이 있을 때만 불러온다(대학 라인 잡기와 같은 방식) ──
  function hasLoginTrace() {
    return ["localStorage", "sessionStorage"].some((store) => tryDo(() => {
      const s = JSON.parse(window[store].getItem("snucoach-auth") || "null");
      return !!(s && s.refresh_token);
    }, false));
  }
  let authP = null;
  function loadAuth() {
    if (authP) return authP;
    const add = (src) => new Promise((ok, no) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = ok;
      s.onerror = no;
      document.head.appendChild(s);
    });
    authP = (window.supabase ? Promise.resolve() : add("assets/vendor/supabase-js-2.117.2.js"))
      .then(() => (window.SnucoachAuth ? null : add("assets/js/auth.js?v=a7")))
      .then(() => {
        const A = window.SnucoachAuth;
        if (!A || !A.ok || !A.reviews) throw new Error("auth");
        return A.reviews;
      });
    authP.catch(() => { authP = null; });
    return authP;
  }

  // ── 쓰기 영역 ──
  const note = (text) => el("p", "mrv-write-note", text);
  function setWrite(next) {
    state = next;
    const box = els.write;
    box.replaceChildren();
    if (next === "signed-out") {
      const a = el("a", "btn btn-primary btn-sm", "로그인하고 후기 쓰기");
      a.href = LOGIN_URL;
      // 구글·카카오 로그인은 마이페이지로 돌아오므로, 거기서 이 화면으로 되돌아오게 표시를 남긴다(같은 탭, 30분)
      a.addEventListener("click", () => { tryDo(() => sessionStorage.setItem(RETURN_KEY, String(Date.now()))); });
      box.append(a, note("후기는 스누코치 회원만 쓸 수 있습니다."));
    } else if (next === "checking") {
      box.append(note("로그인 상태를 확인하는 중…"));
    } else if (next === "onboarding") {
      const a = el("a", "btn btn-primary btn-sm", "가입 마무리하고 후기 쓰기");
      a.href = "account.html";
      box.append(a, note("가입 마무리를 끝내면 후기를 쓸 수 있습니다."));
    } else if (next === "ok") {
      if (PROGRAMS.every((p) => mine.some((m) => m.program === p))) {
        box.append(note("프로그램마다 후기를 하나씩 남길 수 있습니다. 이미 쓴 후기는 아래 「내가 쓴 후기」에서 고칠 수 있습니다."));
      } else {
        const b = el("button", "btn btn-primary btn-sm", "후기 쓰기");
        b.type = "button";
        b.id = "mrvOpen";
        b.setAttribute("aria-expanded", String(!els.form.hidden && !editing));
        b.setAttribute("aria-controls", "mrvForm");
        b.addEventListener("click", () => openForm(null));
        box.append(b);
      }
    } else if (next === "admin") {
      box.append(note("관리자 계정으로는 후기를 쓸 수 없습니다."));
    } else if (next === "banned") {
      const p = note("운영 기준을 되풀이해 위반하여 후기 작성이 제한된 계정입니다. 이의가 있으면 ");
      const a = el("a", null, "카카오톡 채널");
      a.href = KAKAO;
      a.target = "_blank";
      a.rel = "noopener";
      p.append(a, "로 알려 주세요.");
      box.append(p);
    } else if (next === "not-ready") {
      box.append(note("지금은 후기를 올릴 수 없습니다. 잠시 뒤 다시 시도해 주세요."));
    } else {
      box.append(note("회원 기능을 불러오지 못했습니다. 새로고침해 주세요."));
    }
  }

  // ── 내가 쓴 후기 ──
  function mineItem(r) {
    const li = el("li", "mrv-item" + (r.hidden ? " is-hidden" : ""));
    if (r.hidden) {
      const p = el("p", "mrv-hidden-note");
      p.append(`운영 기준(${r.hidden_reason || "기타"})에 따라 숨김 처리되어 다른 사람에게는 보이지 않습니다.`);
      if (r.hidden_detail) p.append(` 사유: ${r.hidden_detail}`);
      p.append(" 내용을 고쳤거나 이의가 있으면 ");
      const a = el("a", null, "카카오톡 채널");
      a.href = KAKAO;
      a.target = "_blank";
      a.rel = "noopener";
      p.append(a, "로 알려 주세요. 확인한 뒤 운영 기준에 해당하지 않으면 다시 게시하고 결과를 알려 드립니다.");
      li.append(p);
    }
    li.append(head(r, false), bodyBlock(r), meta(r));
    const acts = el("div", "mrv-item-actions");
    const normal = () => {
      const edit = el("button", "text-btn", "고치기");
      edit.type = "button";
      edit.setAttribute("aria-label", `${r.program} 후기 고치기`);
      edit.addEventListener("click", () => openForm(r));
      const del = el("button", "text-btn", "지우기");
      del.type = "button";
      del.setAttribute("aria-label", `${r.program} 후기 지우기`);
      del.addEventListener("click", () => {
        // window.confirm 대신 한 번 더 누르게 한다
        const yes = el("button", "btn btn-danger btn-sm", "지우기");
        yes.type = "button";
        const no = el("button", "btn btn-line btn-sm", "취소");
        no.type = "button";
        no.addEventListener("click", () => { normal(); acts.querySelector("button:last-child").focus(); });
        yes.addEventListener("click", () => busy(yes, "지우는 중…", () => removeReview(r)));
        acts.replaceChildren(el("span", "mrv-confirm", "이 후기를 지울까요? 지우면 되돌릴 수 없습니다."), yes, no);
        no.focus();
      });
      acts.replaceChildren(edit, del);
    };
    normal();
    li.append(acts);
    return li;
  }
  function drawMine() {
    els.mineList.replaceChildren(...mine.map(mineItem));
    show(els.mine, !!mine.length);
    fitBodies(els.mineList);
  }
  async function refreshMine() {
    if (!api) return;
    const { data, error } = await api.mine();
    if (error) {
      if (notReady(error) || error.code === "PGRST202") { mine = []; drawMine(); setWrite("not-ready"); return; }
      msg(els.msg, "내가 쓴 후기를 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.");
      return;
    }
    mine = Array.isArray(data) ? data : [];
    drawMine();
    drawList();
    if (state === "ok") setWrite("ok");
  }
  async function removeReview(r) {
    const { error } = await api.remove(r.id);
    if (error && error.code !== "not_found") { msg(els.msg, api.errText(error)); els.msg.focus(); return; }
    if (editing && editing.id === r.id) closeForm();
    await reloadAll();
    msg(els.msg, error ? "이미 지워진 후기입니다." : "후기를 지웠습니다.", error ? "info" : "ok");
    els.msg.focus();
  }
  async function reloadAll() {
    await Promise.all([loadFirst().catch(() => {}), refreshMine(), loadStat()]);
  }

  // ── 작성 폼 ──
  function setErr(input, errEl, text) {
    if (input) input.setAttribute("aria-invalid", text ? "true" : "false");
    errEl.textContent = text || "";
    return !text;
  }
  function syncRate() {
    const v = Number((radios.find((x) => x.checked) || {}).value || 0);
    radios.forEach((x) => x.closest("label").classList.toggle("on", Number(x.value) <= v));
    els.rateText.textContent = v ? `5점 만점에 ${v}점` : "별을 눌러 주세요";
    if (v) { els.rate.classList.remove("is-invalid"); els.rateErr.textContent = ""; }
  }
  function syncCount() {
    els.bodyCount.textContent = `${num(bodyLength(els.body.value))} / ${num(BODY_MAX)}자`;
  }
  function syncProgramNote() {
    const on = !!editing && !!editing.verified && els.program.value !== editing.program;
    els.programNote.textContent = editing && editing.verified ? "프로그램을 바꾸면 수강 확인 표시가 해제됩니다." : "";
    els.programNote.classList.toggle("is-warn", on);
    show(els.programNote, !!editing && !!editing.verified);
  }
  function openForm(r) {
    editing = r || null;
    msg(els.formMsg, "");
    msg(els.msg, "");
    els.formTitle.textContent = editing ? "후기 고치기" : "후기 쓰기";
    els.submit.textContent = editing ? "고친 내용 저장" : "후기 올리기";
    // 이미 후기를 쓴 프로그램은 고를 수 없다(고치는 중인 글의 프로그램은 제외)
    Array.from(els.program.options).forEach((o) => {
      if (!o.value) return;
      const taken = mine.some((m) => m.program === o.value && (!editing || m.id !== editing.id));
      o.disabled = taken;
      o.textContent = o.value + (taken ? " (작성함)" : "");
    });
    els.program.value = editing ? editing.program : "";
    radios.forEach((x) => { x.checked = !!editing && Number(x.value) === Number(editing.rating); });
    els.body.value = editing ? editing.body : "";
    setErr(els.program, els.programErr, "");
    setErr(els.body, els.bodyErr, "");
    els.rate.classList.remove("is-invalid");
    els.rateErr.textContent = "";
    syncRate();
    syncCount();
    syncProgramNote();
    els.preview.textContent = author || "이름의 첫 글자만(예: 김**)";
    show(els.form);
    const open = $("mrvOpen");
    if (open) open.setAttribute("aria-expanded", String(!editing));
    els.formTitle.focus();
    els.form.scrollIntoView({ block: "nearest" });
  }
  function closeForm() {
    show(els.form, false);
    editing = null;
    els.body.value = "";
    els.program.value = "";
    radios.forEach((x) => { x.checked = false; });
    const open = $("mrvOpen");
    if (open) open.setAttribute("aria-expanded", "false");
  }
  function readForm() {
    return {
      program: els.program.value,
      rating: Number((radios.find((x) => x.checked) || {}).value || 0),
      body: cleanBody(els.body.value),
    };
  }
  // 첫 번째 잘못된 칸을 돌려준다(없으면 null). 오류는 모두 표시한다.
  function validate(v) {
    let first = null;
    if (!setErr(els.program, els.programErr, PROGRAMS.includes(v.program) ? "" : "이용한 프로그램을 골라 주세요.")) first = first || els.program;
    const rateErr = v.rating >= 1 && v.rating <= 5 ? "" : "별점을 골라 주세요.";
    els.rate.classList.toggle("is-invalid", !!rateErr);
    els.rateErr.textContent = rateErr;
    if (rateErr) first = first || radios[0];
    const n = Array.from(v.body).length;
    const bodyErr = n < BODY_MIN ? `후기 내용을 ${BODY_MIN}자 이상 적어 주세요.` : n > BODY_MAX ? `후기 내용은 ${num(BODY_MAX)}자까지 쓸 수 있습니다.` : "";
    if (!setErr(els.body, els.bodyErr, bodyErr)) first = first || els.body;
    return first;
  }
  async function submitForm(e) {
    e.preventDefault();
    if (!api || els.submit.disabled) return;
    msg(els.formMsg, "");
    const v = readForm();
    const bad = validate(v);
    if (bad) { bad.focus(); return; }
    const was = editing;
    await busy(els.submit, was ? "저장하는 중…" : "올리는 중…", async () => {
      const { error } = was ? await api.update(was.id, v) : await api.create(v);
      if (error) {
        msg(els.formMsg, api.errText(error));
        if (error.code === "RV002") setWrite("onboarding");
        if (error.code === "RV003") setWrite("admin");
        if (error.code === "RV005") setWrite("banned");
        if (error.code === "23514" && /reviews_body_length/.test(error.message || "")) els.body.focus();
        return;
      }
      closeForm();
      await reloadAll();
      msg(els.msg, !was ? "후기를 올렸습니다."
        : was.hidden ? "후기를 고쳤습니다. 숨김 처리된 후기는 스누코치가 확인한 뒤 다시 게시합니다." : "후기를 고쳤습니다.", "ok");
      els.msg.focus();
    });
  }
  function wireForm() {
    els.form.addEventListener("submit", submitForm);
    els.cancel.addEventListener("click", () => {
      closeForm();
      const open = $("mrvOpen");
      if (open) open.focus(); else els.msg.focus();
    });
    radios.forEach((x) => x.addEventListener("change", syncRate));
    els.body.addEventListener("input", () => { syncCount(); if (els.bodyErr.textContent) setErr(els.body, els.bodyErr, ""); });
    els.program.addEventListener("change", () => { if (els.program.value) setErr(els.program, els.programErr, ""); syncProgramNote(); });
  }

  async function initMember() {
    if (framed) return;
    if (!hasLoginTrace()) { setWrite("signed-out"); return; }
    setWrite("checking");
    try {
      api = await loadAuth();
    } catch (e) {
      setWrite("error");
      return;
    }
    const st = await api.status().catch((error) => ({ state: "error", error }));
    if (st.state === "error" && st.error && (st.error.code === "PGRST202" || notReady(st.error))) { setWrite("not-ready"); return; }
    author = st.author || "";
    setWrite(st.state);
    if (st.state !== "signed-out" && st.state !== "error") await refreshMine();
  }

  async function init() {
    tryDo(() => sessionStorage.removeItem(RETURN_KEY)); // 이 화면으로 바로 돌아왔으면 남은 표시를 지운다
    wireForm();
    els.more.addEventListener("click", loadMore);
    let failed = false;
    try {
      await loadFirst();
    } catch (e) {
      if (notReady(e)) return; // DB 설정 전: 구역을 숨긴 채 둔다
      failed = true;
    }
    show(sec);
    show(els.jump);
    fitBodies(els.list);
    if (failed) failList();
    if (location.hash === "#member-reviews") sec.scrollIntoView({ behavior: "instant", block: "start" });
    if (!failed) loadStat();
    await initMember();
  }
  init().catch(() => { /* 큐레이션 후기는 그대로 보인다 */ });
})();
