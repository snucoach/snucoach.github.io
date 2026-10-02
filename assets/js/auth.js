// 스누코치 회원 기능 — 로그인 · 회원가입 · 비밀번호 찾기 · 마이페이지 · 관리자
// 인증·DB는 Supabase를 쓴다. 설정: assets/js/auth-config.js / DB 구조: supabase/migrations/
// 페이지는 <body data-auth-page="..."> 값으로 구분한다.
(function () {
  "use strict";
  const CFG = window.SNUCOACH_AUTH || {};
  const PAGE = document.body.dataset.authPage;
  const STORAGE_KEY = "snucoach-auth";
  const REMEMBER_KEY = "snucoach-auth-remember";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const TYPES = ["학생", "학부모", "기타"];
  const GRADES = ["초등", "중1", "중2", "중3", "고1", "고2", "고3", "N수", "기타"];

  // ── 다른 사이트의 프레임 안에서 열리면(클릭재킹) 회원 화면을 띄우지 않는다 ──
  // GitHub Pages 는 X-Frame-Options 헤더를 붙일 수 없어 스크립트로 막는다.
  if (PAGE && window.top !== window.self) {
    const main = document.querySelector("main");
    if (main) main.replaceChildren(Object.assign(document.createElement("p"), {
      className: "auth-loading",
      textContent: "보안을 위해 이 페이지는 스누코치 사이트에서 직접 열어 주세요.",
    }));
    return;
  }

  // ── 설정 점검: 비어 있거나, 공개되면 안 되는 비밀 키가 들어 있으면 멈춘다 ──
  function configProblem() {
    if (!CFG.url || !CFG.key) return "missing";
    if (/^sb_secret_/i.test(CFG.key)) return "secret";
    const parts = CFG.key.split(".");
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (payload.role && payload.role !== "anon") return "secret";
      } catch (e) { /* JWT 가 아니면 서버가 판단한다 */ }
    }
    return null;
  }

  // ── 로그인 유지: 체크하면 localStorage(브라우저를 닫아도 유지), 해제하면 sessionStorage(탭을 닫으면 로그아웃) ──
  function tryDo(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  const remember = {
    get: () => tryDo(() => localStorage.getItem(REMEMBER_KEY) !== "0", true),
    set: (on) => tryDo(() => localStorage.setItem(REMEMBER_KEY, on ? "1" : "0")),
  };
  const storage = {
    getItem: (k) => tryDo(() => localStorage.getItem(k), null) ?? tryDo(() => sessionStorage.getItem(k), null),
    setItem: (k, v) => {
      // 인증 메일·카카오 로그인용 확인값(code-verifier)은 새 탭에서도 읽혀야 해서 항상 localStorage
      const persistent = remember.get() || k.endsWith("-code-verifier");
      tryDo(() => (persistent ? sessionStorage : localStorage).removeItem(k));
      tryDo(() => (persistent ? localStorage : sessionStorage).setItem(k, v));
    },
    removeItem: (k) => {
      tryDo(() => localStorage.removeItem(k));
      tryDo(() => sessionStorage.removeItem(k));
    },
  };

  let client = null;
  function sb() {
    if (!client) {
      client = window.supabase.createClient(CFG.url, CFG.key, {
        auth: {
          storageKey: STORAGE_KEY,
          storage,
          flowType: "pkce",
          detectSessionInUrl: true,
          persistSession: true,
          autoRefreshToken: true,
        },
      });
    }
    return client;
  }

  // ── 오류 문구 ──
  const ERR = {
    invalid_credentials: "이메일 또는 비밀번호가 맞지 않습니다.",
    email_not_confirmed: "이메일 인증이 아직 끝나지 않았습니다. 가입할 때 받은 메일의 [이메일 인증하기]를 눌러 주세요.",
    user_already_exists: "이미 가입한 이메일입니다. 로그인하거나 비밀번호를 찾아 주세요.",
    email_exists: "이미 가입한 이메일입니다. 로그인하거나 비밀번호를 찾아 주세요.",
    weak_password: "비밀번호가 너무 쉽습니다. 8자 이상, 영문과 숫자를 섞어 주세요.",
    same_password: "지금 쓰는 비밀번호와 다른 비밀번호를 정해 주세요.",
    current_password_required: "현재 비밀번호를 입력해 주세요.",
    current_password_mismatch: "현재 비밀번호가 맞지 않습니다.",
    over_email_send_rate_limit: "메일을 너무 자주 요청했습니다. 잠시 뒤 다시 시도해 주세요.",
    over_request_rate_limit: "요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
    email_address_invalid: "사용할 수 없는 이메일 주소입니다. 다른 주소를 입력해 주세요.",
    email_address_not_authorized: "지금은 메일을 보낼 수 없습니다. 카카오톡 채널로 문의해 주세요.",
    signup_disabled: "지금은 회원가입을 받지 않고 있습니다.",
    email_provider_disabled: "지금은 이메일 가입·로그인을 받지 않고 있습니다.",
    otp_expired: "링크가 만료되었거나 이미 사용되었습니다. 다시 요청해 주세요.",
    flow_state_expired: "링크가 만료되었습니다. 다시 요청해 주세요.",
    flow_state_not_found: "링크가 만료되었거나 이미 사용되었습니다. 다시 요청해 주세요.",
    bad_code_verifier: "메일을 요청한 브라우저에서 링크를 열어 주세요.",
    session_not_found: "로그인이 만료되었습니다. 다시 로그인해 주세요.",
    refresh_token_not_found: "로그인이 만료되었습니다. 다시 로그인해 주세요.",
    user_not_found: "계정을 찾을 수 없습니다.",
    user_banned: "이용이 제한된 계정입니다. 카카오톡 채널로 문의해 주세요.",
    validation_failed: "입력한 내용을 다시 확인해 주세요.",
    "42501": "권한이 없습니다. 다시 로그인해 주세요.",
  };
  function errText(error) {
    if (!error) return "";
    const code = error.code || (error.details && error.details.code);
    if (code && ERR[code]) return ERR[code];
    if (error.name === "AuthRetryableFetchError" || error.name === "TypeError" || /fetch|network|load failed/i.test(error.message || "")) {
      return "서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.";
    }
    if (error.status === 429) return ERR.over_request_rate_limit;
    return "문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요." + (code || error.message ? ` (${code || error.message})` : "");
  }
  const isNetworkError = (e) => !!e && (e.name === "AuthRetryableFetchError" || e.status === 0 || /fetch|network|load failed/i.test(e.message || ""));

  // ── 화면 도우미 ──
  function msg(el, text, kind = "error") {
    if (!el) return;
    el.className = `auth-msg is-${kind}`;
    el.textContent = text || "";
    el.hidden = !text;
  }
  function show(el, on = true) { if (el) el.hidden = !on; }
  function focusEl(el) { if (el) { el.focus({ preventScroll: false }); } }
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
  function cooldown(btn, seconds) {
    const label = btn.textContent;
    btn.disabled = true;
    let left = seconds;
    const tick = () => {
      if (left <= 0) { btn.disabled = false; btn.textContent = label; return; }
      btn.textContent = `${label} (${left}초 후 가능)`;
      left -= 1;
      setTimeout(tick, 1000);
    };
    tick();
  }
  function setErr(input, errEl, text) {
    if (input) input.setAttribute("aria-invalid", text ? "true" : "false");
    if (errEl) errEl.textContent = text || "";
    return !text;
  }
  const site = (path) => new URL(path, location.href).href;
  function cleanUrl() { history.replaceState(history.state, "", location.pathname); }
  function nextUrl(fallback = "account.html") {
    const raw = new URLSearchParams(location.search).get("next");
    if (!raw) return fallback;
    try {
      const u = new URL(raw, location.href);
      if (u.origin !== location.origin || /\/(login|signup)\.html$/.test(u.pathname)) return fallback;
      return u.pathname + u.search + u.hash;
    } catch (e) { return fallback; }
  }
  const fmtDate = (iso) => (iso ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "long", timeZone: "Asia/Seoul" }).format(new Date(iso)) : "-");
  const fmtDateTime = (iso) => (iso ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul" }).format(new Date(iso)) : "-");
  function setNavSignedOut() {
    $$("[data-auth-nav]").forEach((a) => {
      a.setAttribute("href", a.getAttribute("href").replace("account.html", "login.html"));
      const lb = a.querySelector("[data-auth-label]");
      if (lb) lb.textContent = a.classList.contains("drawer-auth") ? "로그인 · 회원가입" : "로그인";
    });
  }

  // ── 비밀번호 보기 버튼 ──
  $$(".pw-toggle").forEach((b) => b.addEventListener("click", () => {
    const input = document.getElementById(b.getAttribute("aria-controls"));
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    b.textContent = reveal ? "숨기기" : "보기";
    b.setAttribute("aria-pressed", String(reveal));
  }));

  // ── 입력 검사 ──
  function pwProblem(pw) {
    if (!pw) return "비밀번호를 입력해 주세요.";
    if (pw.length < 8) return "8자 이상 입력해 주세요.";
    if (pw.length > 72) return "72자 이하로 입력해 주세요.";
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "영문과 숫자를 함께 써 주세요.";
    return "";
  }
  function checkNewPassword(pwInput, pw2Input) {
    const e1 = pwProblem(pwInput.value);
    const ok1 = setErr(pwInput, document.getElementById(pwInput.id + "Err"), e1);
    const e2 = pw2Input.value !== pwInput.value ? "비밀번호가 서로 다릅니다." : "";
    const ok2 = setErr(pw2Input, document.getElementById(pw2Input.id + "Err"), e2);
    if (!ok1) return pwInput;
    if (!ok2) return pw2Input;
    return null;
  }

  // 이름·회원 구분·학년 (회원가입·가입 마무리·내 정보 공통)
  function profileForm(form, prefix) {
    const name = $(`#${prefix}Name`, form);
    const grade = $(`#${prefix}Grade`, form);
    const typeSet = $(`#${prefix}Type`, form);
    const gradeLabel = $("[data-grade-label]", form);
    const radios = $$('input[name="member_type"]', form);
    const syncLabel = () => {
      const t = (radios.find((r) => r.checked) || {}).value;
      gradeLabel.textContent = t === "학부모" ? "자녀 학년" : "학년";
    };
    radios.forEach((r) => r.addEventListener("change", () => {
      syncLabel();
      typeSet.classList.remove("is-invalid");
      $(`#${prefix}TypeErr`, form).textContent = "";
    }));
    return {
      fill(p) {
        name.value = p.name || "";
        radios.forEach((r) => { r.checked = r.value === p.member_type; });
        grade.value = GRADES.includes(p.grade) ? p.grade : "";
        syncLabel();
      },
      read() {
        return {
          name: name.value.trim(),
          member_type: (radios.find((r) => r.checked) || {}).value || null,
          grade: grade.value || null,
        };
      },
      // 첫 번째 잘못된 칸을 돌려준다(없으면 null)
      validate() {
        const v = this.read();
        let first = null;
        const nameErr = !v.name ? "이름을 입력해 주세요." : v.name.length > 20 ? "20자 이하로 입력해 주세요." : "";
        if (!setErr(name, $(`#${prefix}NameErr`, form), nameErr)) first = first || name;
        const typeErr = TYPES.includes(v.member_type) ? "" : "회원 구분을 골라 주세요.";
        typeSet.classList.toggle("is-invalid", !!typeErr);
        $(`#${prefix}TypeErr`, form).textContent = typeErr;
        if (typeErr) first = first || radios[0];
        const gradeErr = GRADES.includes(v.grade) ? "" : "학년을 골라 주세요.";
        if (!setErr(grade, $(`#${prefix}GradeErr`, form), gradeErr)) first = first || grade;
        return first;
      },
    };
  }

  // 약관 동의 묶음: 전체 동의 ↔ 개별 항목
  function consentBox(box, prefix) {
    const all = $("[data-agree-all]", box);
    const items = $$("[data-agree]", box);
    const sync = () => { all.checked = items.every((i) => i.checked); };
    all.addEventListener("change", () => { items.forEach((i) => { i.checked = all.checked; }); clear(); });
    items.forEach((i) => i.addEventListener("change", () => { sync(); clear(); }));
    const err = document.getElementById(`${prefix}ConsentErr`);
    function clear() { if (items.filter((i) => i.dataset.agree !== "marketing").every((i) => i.checked)) { box.classList.remove("is-invalid"); err.textContent = ""; } }
    return {
      read: () => Object.fromEntries(items.map((i) => [i.dataset.agree, i.checked])),
      validate() {
        const v = this.read();
        const missing = !v.age ? "만 14세 이상인지 확인해 주세요." : !v.terms || !v.privacy ? "필수 약관에 동의해 주세요." : "";
        box.classList.toggle("is-invalid", !!missing);
        err.textContent = missing;
        return missing ? items.find((i) => i.dataset.agree !== "marketing" && !i.checked) : null;
      },
    };
  }

  // 구글·카카오 로그인 버튼 (auth-config.js 에서 켠 것만 보인다)
  const PROVIDER_NAMES = { email: "이메일", google: "구글", kakao: "카카오" };
  const oauthEnabled = () => ["google", "kakao"].filter((p) => CFG[p]);
  function wireOAuth(beforeRedirect) {
    const enabled = oauthEnabled();
    if (!enabled.length) return;
    $$("[data-auth-social]").forEach((el) => show(el));
    $$("[data-oauth]").forEach((btn) => {
      const provider = btn.dataset.oauth;
      if (!enabled.includes(provider)) return;
      show(btn);
      btn.addEventListener("click", async () => {
        if (beforeRedirect) beforeRedirect();
        await busy(btn, `${PROVIDER_NAMES[provider]}로 이동 중…`, async () => {
          const { error } = await sb().auth.signInWithOAuth({ provider, options: { redirectTo: site("account.html") } });
          if (error) msg($("#authMsg"), errText(error));
        });
      });
    });
  }

  async function resendSignup(email, out, btn) {
    const { error } = await sb().auth.resend({ type: "signup", email, options: { emailRedirectTo: site("account.html") } });
    if (error) { msg(out, errText(error)); return; }
    msg(out, "인증 메일을 다시 보냈습니다. 메일함을 확인해 주세요.", "ok");
    if (btn) cooldown(btn, 60);
  }

  // ─────────────────────────────────────────────────────────
  // 로그인
  async function pageLogin() {
    const form = $("#loginForm");
    const out = $("#authMsg");
    const rememberBox = $("#loginRemember");
    const q = new URLSearchParams(location.search);
    const notice = {
      expired: ["로그인이 만료되었습니다. 다시 로그인해 주세요.", "info"],
      verified: ["인증 링크를 확인했습니다. 로그인해 주세요.", "ok"],
      "signed-out-all": ["모든 기기에서 로그아웃했습니다.", "ok"],
    }[q.get("m")];
    if (notice) msg(out, ...notice);

    rememberBox.checked = remember.get();
    wireOAuth(() => remember.set(rememberBox.checked));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("#loginEmail").value.trim();
      const password = $("#loginPw").value;
      if (!EMAIL_RE.test(email) || !password) {
        msg(out, "이메일과 비밀번호를 입력해 주세요.");
        focusEl(!EMAIL_RE.test(email) ? $("#loginEmail") : $("#loginPw"));
        return;
      }
      remember.set(rememberBox.checked);
      await busy($('button[type="submit"]', form), "로그인 중…", async () => {
        const { error } = await sb().auth.signInWithPassword({ email, password });
        if (!error) { location.replace(nextUrl()); return; }
        msg(out, errText(error));
        if (error.code === "email_not_confirmed") {
          const actions = document.createElement("div");
          actions.className = "msg-actions";
          const b = document.createElement("button");
          b.type = "button";
          b.className = "link";
          b.textContent = "인증 메일 다시 보내기";
          b.addEventListener("click", () => busy(b, "보내는 중…", () => resendSignup(email, out)));
          actions.append(b);
          out.append(actions);
        } else {
          $("#loginPw").select();
        }
      });
    });

    const { data: { session } } = await sb().auth.getSession();
    if (session) location.replace(nextUrl());
  }

  // ─────────────────────────────────────────────────────────
  // 회원가입
  async function pageSignup() {
    const form = $("#signupForm");
    const out = $("#authMsg");
    wireOAuth(() => remember.set(true));
    const prof = profileForm(form, "su");
    const consent = consentBox($("#suConsent"), "su");
    const email = $("#suEmail");
    const pw = $("#suPw");
    const pw2 = $("#suPw2");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      msg(out, "");
      const emailVal = email.value.trim();
      const bad = [
        setErr(email, $("#suEmailErr"), EMAIL_RE.test(emailVal) ? "" : "이메일 주소를 정확히 입력해 주세요.") ? null : email,
        checkNewPassword(pw, pw2),
        prof.validate(),
        consent.validate(),
      ].find(Boolean);
      if (bad) { focusEl(bad); return; }

      const p = prof.read();
      const c = consent.read();
      remember.set(true);
      await busy($('button[type="submit"]', form), "가입하는 중…", async () => {
        const { data, error } = await sb().auth.signUp({
          email: emailVal,
          password: pw.value,
          options: {
            emailRedirectTo: site("account.html"),
            data: {
              name: p.name, member_type: p.member_type, grade: p.grade,
              agree_terms: c.terms, agree_privacy: c.privacy, agree_age: c.age, marketing: c.marketing,
            },
          },
        });
        if (error) {
          msg(out, errText(error));
          if (error.code === "weak_password") focusEl(pw);
          else out.scrollIntoView({ block: "center", behavior: "smooth" });
          return;
        }
        if (data.session) { location.replace("account.html?welcome=1"); return; }
        // 이메일 인증 대기
        $("#doneEmail").textContent = emailVal;
        show($("#signupCard"), false);
        show($("#signupDone"));
        focusEl($("#doneTitle"));
        const resend = $("#resendBtn");
        cooldown(resend, 60);
        resend.addEventListener("click", () => busy(resend, "보내는 중…", () => resendSignup(emailVal, $("#doneMsg"), resend)));
      });
    });

    const { data: { session } } = await sb().auth.getSession();
    if (session) location.replace("account.html");
  }

  // ─────────────────────────────────────────────────────────
  // 비밀번호 찾기 · 재설정
  async function pageReset() {
    const q = new URLSearchParams(location.search);
    const h = new URLSearchParams(location.hash.slice(1));
    const loading = $("#pageLoading");
    let recovery = false;
    sb().auth.onAuthStateChange((event) => { if (event === "PASSWORD_RECOVERY") recovery = true; });

    const showRequest = (text) => {
      show(loading, false);
      show($("#reqCard"));
      if (text) msg($("#authMsg"), text);
      wireRequest();
    };
    const showNew = () => {
      show(loading, false);
      show($("#reqCard"), false);
      show($("#newCard"));
      focusEl($("#newTitle"));
      wireNew();
    };

    // ① 한국어 메일 템플릿 링크: ?token_hash=…&type=recovery (다른 기기에서 열어도 된다)
    const tokenHash = q.get("token_hash");
    if (tokenHash && q.get("type") === "recovery") {
      cleanUrl();
      const { error } = await sb().auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
      if (error) { showRequest("링크가 만료되었거나 이미 사용되었습니다. 아래에서 다시 요청해 주세요."); return; }
      showNew();
      return;
    }
    // ② 기본 메일 템플릿 링크: ?code=… (요청한 브라우저에서만 된다)
    const hadCode = q.has("code");
    const urlError = q.get("error_description") || h.get("error_description");
    const { error: initError } = await sb().auth.initialize();
    if (hadCode || urlError) cleanUrl();
    if (urlError || initError) { showRequest("링크가 만료되었거나 이미 사용되었습니다. 아래에서 다시 요청해 주세요."); return; }
    await new Promise((r) => setTimeout(r, 0)); // PASSWORD_RECOVERY 알림은 초기화 직후에 온다
    const { data: { session } } = await sb().auth.getSession();
    if (session && (recovery || hadCode)) { showNew(); return; }
    if (hadCode) { showRequest("재설정 링크는 메일을 요청한 브라우저에서 열어야 합니다. 여기서 다시 요청해 주세요."); return; }
    showRequest();
  }

  function wireRequest() {
    if (wireRequest.done) return;
    wireRequest.done = true;
    if (oauthEnabled().length) $$("[data-auth-social]").forEach((el) => show(el));
    const form = $("#reqForm");
    const out = $("#authMsg");
    const send = async (email, outEl) => {
      const { error } = await sb().auth.resetPasswordForEmail(email, { redirectTo: site("reset-password.html") });
      if (error) { msg(outEl, errText(error)); return false; }
      return true;
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("#reqEmail").value.trim();
      if (!EMAIL_RE.test(email)) { msg(out, "이메일 주소를 정확히 입력해 주세요."); focusEl($("#reqEmail")); return; }
      await busy($('button[type="submit"]', form), "보내는 중…", async () => {
        if (!(await send(email, out))) return;
        $("#reqDoneEmail").textContent = email;
        show($("#reqCard"), false);
        show($("#reqDone"));
        focusEl($("#reqDoneTitle"));
        const again = $("#reqResendBtn");
        cooldown(again, 60);
        again.onclick = () => busy(again, "보내는 중…", async () => {
          if (await send(email, $("#reqDoneMsg"))) { msg($("#reqDoneMsg"), "메일을 다시 보냈습니다.", "ok"); cooldown(again, 60); }
        });
      });
    });
  }

  function wireNew() {
    const form = $("#newForm");
    const out = $("#newMsg");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const bad = checkNewPassword($("#newPw"), $("#newPw2"));
      if (bad) { focusEl(bad); return; }
      await busy($('button[type="submit"]', form), "바꾸는 중…", async () => {
        const { error } = await sb().auth.updateUser({ password: $("#newPw").value });
        if (error) { msg(out, errText(error)); return; }
        show($("#newCard"), false);
        show($("#newDone"));
        focusEl($("#newDoneTitle"));
      });
    });
  }

  // ─────────────────────────────────────────────────────────
  // 마이페이지
  const isComplete = (p) => !!(p && p.name && p.member_type && p.grade && p.terms_agreed_at && p.privacy_agreed_at && p.age_confirmed_at);

  async function pageAccount() {
    const out = $("#authMsg");
    const loading = $("#pageLoading");
    const q = new URLSearchParams(location.search);
    const h = new URLSearchParams(location.hash.slice(1));
    let notice = q.get("welcome") ? ["가입이 완료되었습니다. 스누코치 회원이 되신 걸 환영합니다!", "ok"] : null;
    const linkFail = (text) => {
      show(loading, false);
      msg(out, text);
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      const a = document.createElement("a");
      a.className = "btn btn-line btn-sm";
      a.href = "login.html";
      a.textContent = "로그인하러 가기";
      actions.append(a);
      out.append(actions);
    };

    // ① 한국어 메일 템플릿의 인증 링크: ?token_hash=…&type=email
    const tokenHash = q.get("token_hash");
    const type = q.get("type");
    if (tokenHash && type) {
      cleanUrl();
      const { error } = await sb().auth.verifyOtp({ token_hash: tokenHash, type: type === "signup" ? "email" : type });
      if (error) { linkFail("인증 링크가 만료되었거나 이미 사용되었습니다. 이미 인증을 마쳤다면 로그인해 주세요. 로그인이 안 되면 로그인 화면에서 인증 메일을 다시 받을 수 있습니다."); return; }
      notice = ["이메일 인증이 완료되었습니다. 스누코치 회원이 되신 걸 환영합니다!", "ok"];
    }

    // ② 기본 메일 템플릿·카카오 로그인 복귀: ?code=… / 실패 시 ?error=…
    const hadCode = q.has("code");
    const urlError = q.get("error_description") || h.get("error_description");
    const { error: initError } = await sb().auth.initialize();
    if (hadCode || urlError || q.has("welcome")) cleanUrl();
    if (urlError || initError) {
      const code = (initError && (initError.code || (initError.details && initError.details.code))) || q.get("error_code") || h.get("error_code");
      linkFail(code === "otp_expired" ? ERR.otp_expired : `로그인을 마치지 못했습니다. 다시 시도해 주세요.${code ? ` (${code})` : ""}`);
      return;
    }

    const { data: { session } } = await sb().auth.getSession();
    if (!session) {
      location.replace(hadCode ? "login.html?m=verified" : "login.html?next=account.html");
      return;
    }

    // ③ 서버에서 계정 확인(탈퇴·정지된 계정의 오래된 로그인 정리)
    const { data: userData, error: userErr } = await sb().auth.getUser();
    if (userErr || !userData.user) {
      if (userErr && isNetworkError(userErr)) { show(loading, false); msg(out, errText(userErr)); return; }
      await sb().auth.signOut({ scope: "local" });
      location.replace("login.html?m=expired&next=account.html");
      return;
    }
    const user = userData.user;
    const { data: profile, error: pErr } = await sb().from("profiles").select("*").eq("id", user.id).maybeSingle();
    show(loading, false);
    if (pErr) { msg(out, errText(pErr)); return; }
    $$("[data-sign-out]").forEach((b) => b.addEventListener("click", () => busy(b, "로그아웃 중…", signOutHere)));

    if (!isComplete(profile)) renderOnboarding(user, profile || {});
    else renderAccount(user, profile, notice);
  }

  async function signOutHere() {
    await sb().auth.signOut({ scope: "local" });
    location.replace("index.html");
  }

  function renderOnboarding(user, profile) {
    const card = $("#onboard");
    const form = $("#onboardForm");
    const out = $("#onboardMsg");
    const prof = profileForm(form, "ob");
    const consent = consentBox($("#obConsent"), "ob");
    const meta = user.user_metadata || {};
    prof.fill({ ...profile, name: profile.name || String(meta.name || meta.full_name || "").slice(0, 20) });
    show(card);
    focusEl($("#onboardTitle"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      msg(out, "");
      const bad = [prof.validate(), consent.validate()].find(Boolean); // 오류는 모두 표시하고 첫 칸으로 이동
      if (bad) { focusEl(bad); return; }
      const p = prof.read();
      const c = consent.read();
      const now = new Date().toISOString(); // 서버가 자기 시각으로 바꿔 기록한다
      await busy($('button[type="submit"]', form), "저장하는 중…", async () => {
        const { data, error } = await sb().from("profiles")
          .update({ ...p, marketing_opt_in: c.marketing, terms_agreed_at: now, privacy_agreed_at: now, age_confirmed_at: now })
          .eq("id", user.id).select().maybeSingle();
        if (error || !data) { msg(out, error ? errText(error) : "회원 정보를 찾지 못했습니다. 카카오톡 채널로 문의해 주세요."); return; }
        show(card, false);
        renderAccount(user, data, ["가입이 완료되었습니다. 스누코치 회원이 되신 걸 환영합니다!", "ok"]);
      });
    });
  }

  function renderAccount(user, profile, notice) {
    const out = $("#authMsg");
    if (notice) msg(out, ...notice);
    const providers = (user.app_metadata && user.app_metadata.providers) || [user.app_metadata && user.app_metadata.provider].filter(Boolean);
    const head = (p) => {
      $("#acctName").textContent = p.name;
      $("#acctAvatar").textContent = (p.name || "?").slice(0, 1);
      const badges = $("#acctBadges");
      badges.replaceChildren();
      [p.member_type, p.grade && (p.member_type === "학부모" ? `자녀 ${p.grade}` : p.grade), p.is_admin && "관리자"].filter(Boolean).forEach((t, i, arr) => {
        const s = document.createElement("span");
        s.className = "badge" + (t === "관리자" && i === arr.length - 1 ? " gold" : "");
        s.textContent = t;
        badges.append(s);
      });
    };
    head(profile);
    $("#acctEmail").textContent = user.email || "-";
    $("#acctProvider").textContent = providers.map((x) => PROVIDER_NAMES[x] || x).join(", ") || "-";
    $("#acctJoined").textContent = fmtDate(user.created_at);
    show($("#adminLink"), !!profile.is_admin);
    show($("#acct"));

    // 내 정보
    const pform = $("#profileForm");
    const prof = profileForm(pform, "pf");
    prof.fill(profile);
    pform.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pout = $("#profileMsg");
      msg(pout, "");
      const bad = prof.validate();
      if (bad) { focusEl(bad); return; }
      await busy($('button[type="submit"]', pform), "저장하는 중…", async () => {
        const { data, error } = await sb().from("profiles").update(prof.read()).eq("id", user.id).select().maybeSingle();
        if (error || !data) { msg(pout, error ? errText(error) : "저장하지 못했습니다. 다시 로그인해 주세요."); return; }
        profile = data;
        head(data);
        msg(pout, "저장했습니다.", "ok");
      });
    });

    // 마케팅 수신 동의 — 바꿀 때마다 처리 결과(일자·내용)를 바로 알린다
    const mkt = $("#mktToggle");
    const mktLog = $("#mktLog");
    const logText = (p) => (p.marketing_opt_in_at
      ? `${fmtDate(p.marketing_opt_in_at)} 수신 ${p.marketing_opt_in ? "동의" : "거부"} 처리됨`
      : "아직 수신에 동의하지 않았습니다.");
    mkt.checked = !!profile.marketing_opt_in;
    mktLog.textContent = logText(profile);
    mkt.addEventListener("change", async () => {
      const want = mkt.checked;
      const mout = $("#mktMsg");
      mkt.disabled = true;
      const { data, error } = await sb().from("profiles").update({ marketing_opt_in: want }).eq("id", user.id).select().maybeSingle();
      mkt.disabled = false;
      if (error || !data) { mkt.checked = !want; msg(mout, error ? errText(error) : "저장하지 못했습니다."); return; }
      profile = data;
      mktLog.textContent = logText(data);
      msg(mout, `스누코치는 ${fmtDate(data.marketing_opt_in_at)}에 회원님의 마케팅 정보(이메일) 수신 ${want ? "동의" : "거부"}를 처리했습니다.`, "ok");
    });

    // 비밀번호 변경 (이메일로 가입한 회원만)
    if (providers.includes("email")) {
      show($("#pwCard"));
      const f = $("#pwForm");
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const pout = $("#pwMsg");
        msg(pout, "");
        const cur = $("#curPw");
        if (!setErr(cur, $("#curPwErr"), cur.value ? "" : "현재 비밀번호를 입력해 주세요.")) { focusEl(cur); return; }
        const bad = checkNewPassword($("#chPw"), $("#chPw2"));
        if (bad) { focusEl(bad); return; }
        await busy($('button[type="submit"]', f), "바꾸는 중…", async () => {
          const check = await sb().auth.signInWithPassword({ email: user.email, password: cur.value });
          if (check.error) {
            if (check.error.code === "invalid_credentials") { setErr(cur, $("#curPwErr"), "현재 비밀번호가 맞지 않습니다."); focusEl(cur); }
            else msg(pout, errText(check.error));
            return;
          }
          const { error } = await sb().auth.updateUser({ password: $("#chPw").value, current_password: cur.value });
          if (error) { msg(pout, errText(error)); return; }
          f.reset();
          msg(pout, "비밀번호를 바꿨습니다. 다른 기기에서도 새 비밀번호로 로그인해 주세요.", "ok");
        });
      });
    }

    // 목표 대학 입시 정보 알림: 로그인 전에 고른 대학이 있으면 저장하고, 신청 목록을 보여 준다
    (async () => {
      const aout = $("#alertMsg");
      const saved = await alerts.flushPending();
      if (saved.length) msg(aout, `${saved.join("·")} 입시 정보 알림을 신청했습니다.`, "ok");
      const draw = async () => {
        const { data, error } = await alerts.list();
        const box = $("#alertList");
        if (error) { msg(aout, errText(error)); return; }
        box.replaceChildren(...(data || []).map((a) => {
          const li = document.createElement("li");
          const t = document.createElement("span");
          t.className = "al-name";
          t.textContent = a.univ + (a.track ? ` · ${a.track}` : "");
          const b = document.createElement("button");
          b.type = "button";
          b.className = "text-btn";
          b.textContent = "해제";
          b.setAttribute("aria-label", `${a.univ} 알림 해제`);
          b.addEventListener("click", () => busy(b, "해제 중…", async () => {
            const { error: e } = await alerts.remove(a.univ);
            if (e) { msg(aout, errText(e)); return; }
            msg(aout, `${a.univ} 알림을 해제했습니다.`, "ok");
            await draw();
          }));
          li.append(t, b);
          return li;
        }));
        show($("#alertEmpty"), !(data || []).length);
      };
      await draw();
    })();

    // 모든 기기에서 로그아웃
    $("#signOutAll").addEventListener("click", async (e) => {
      if (!window.confirm("이 기기를 포함해 로그인된 모든 기기에서 로그아웃하시겠습니까?")) return;
      await busy(e.currentTarget, "로그아웃 중…", async () => {
        const { error } = await sb().auth.signOut({ scope: "global" });
        if (error && !isNetworkError(error)) await sb().auth.signOut({ scope: "local" });
        else if (error) { msg($("#authMsg"), errText(error)); return; }
        location.replace("login.html?m=signed-out-all");
      });
    });

    // 회원 탈퇴
    const delInput = $("#delConfirm");
    const delBtn = $("#delBtn");
    delInput.addEventListener("input", () => { delBtn.disabled = delInput.value.trim() !== "탈퇴"; });
    delBtn.addEventListener("click", async () => {
      if (!window.confirm("정말 탈퇴하시겠습니까? 회원 정보가 바로 삭제되며 되돌릴 수 없습니다.")) return;
      await busy(delBtn, "탈퇴 처리 중…", async () => {
        const { error } = await sb().rpc("delete_my_account");
        if (error) { msg($("#delMsg"), errText(error)); return; }
        await sb().auth.signOut({ scope: "local" }).catch(() => {});
        storage.removeItem(STORAGE_KEY);
        setNavSignedOut();
        show($("#acct"), false);
        msg($("#authMsg"), "");
        show($("#deletedCard"));
        focusEl($("#deletedTitle"));
      });
      delBtn.disabled = delInput.value.trim() !== "탈퇴";
    });
  }

  // ─────────────────────────────────────────────────────────
  // 관리자: 회원 목록
  async function pageAdmin() {
    const out = $("#authMsg");
    const loading = $("#pageLoading");
    const { data: { session } } = await sb().auth.getSession();
    if (!session) { location.replace("login.html?next=admin.html"); return; }

    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb().rpc("admin_list_members").range(from, from + 999);
      if (error) {
        show(loading, false);
        // 관리자 확인에서 거절된 경우와 그 밖의 권한 오류를 구분해 보여 준다(원인 파악용)
        msg(out, error.code === "42501" && /관리자만/.test(error.message || "")
          ? "관리자만 볼 수 있는 페이지입니다. 관리자로 지정한 계정으로 로그인했는지 확인해 주세요."
          : `회원 목록을 불러오지 못했습니다. (${error.code || ""} ${error.message || ""})`);
        return;
      }
      rows.push(...data);
      if (data.length < 1000) break;
    }
    show(loading, false);
    show($("#admBody"));

    const count = (fn) => rows.filter(fn).length;
    const stats = [
      ["전체 회원", rows.length],
      ["학생", count((r) => r.member_type === "학생")],
      ["학부모", count((r) => r.member_type === "학부모")],
      ["기타", count((r) => r.member_type === "기타")],
      ["가입 마무리 전", count((r) => !r.profile_completed || !r.email_confirmed)],
      ["마케팅 수신 동의", count((r) => r.marketing_opt_in)],
    ];
    $("#admStats").replaceChildren(...stats.map(([label, n]) => {
      const d = document.createElement("div");
      d.className = "stat";
      const b = document.createElement("b");
      b.textContent = n.toLocaleString("ko-KR");
      const s = document.createElement("span");
      s.textContent = label;
      d.append(b, s);
      return d;
    }));

    const search = $("#admSearch");
    const onlyMkt = $("#admMkt");
    const body = $("#admRows");
    const provider = (r) => PROVIDER_NAMES[r.provider] || r.provider;
    const status = (r) => (!r.email_confirmed ? "메일 인증 전" : !r.profile_completed ? "가입 마무리 전" : "");
    let shown = rows;
    function render() {
      const qv = search.value.trim().toLowerCase();
      shown = rows.filter((r) => (!onlyMkt.checked || r.marketing_opt_in)
        && (!qv || (r.name || "").toLowerCase().includes(qv) || (r.email || "").toLowerCase().includes(qv)));
      body.replaceChildren(...shown.map((r) => {
        const tr = document.createElement("tr");
        [fmtDate(r.created_at), r.name || status(r) || "-", r.email || "-", r.member_type || "-", r.grade || "-",
          r.marketing_opt_in ? `동의 (${fmtDate(r.marketing_opt_in_at)})` : "-", provider(r), fmtDateTime(r.last_sign_in_at)]
          .forEach((v, i) => {
            const td = document.createElement("td");
            td.textContent = v;
            if ((i === 1 && !r.name) || v === "-") td.className = "muted";
            tr.append(td);
          });
        return tr;
      }));
      if (!shown.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 8;
        td.className = "adm-empty";
        td.textContent = rows.length ? "조건에 맞는 회원이 없습니다." : "아직 회원이 없습니다.";
        tr.append(td);
        body.append(tr);
      }
      $("#admCount").textContent = `${shown.length.toLocaleString("ko-KR")}명 표시 중 (전체 ${rows.length.toLocaleString("ko-KR")}명)`;
    }
    search.addEventListener("input", render);
    onlyMkt.addEventListener("change", render);
    render();

    $("#admCsv").addEventListener("click", () => downloadCsv("snucoach-members",
      ["가입일시", "이름", "이메일", "회원 구분", "학년", "마케팅 수신 동의", "마케팅 동의·거부 일시", "가입 방식", "이메일 인증", "가입 마무리", "최근 로그인"],
      shown.map((r) => [
        fmtDateTime(r.created_at), r.name, r.email, r.member_type, r.grade, r.marketing_opt_in ? "동의" : "미동의",
        r.marketing_opt_in_at ? fmtDateTime(r.marketing_opt_in_at) : "", provider(r), r.email_confirmed ? "완료" : "전",
        r.profile_completed ? "완료" : "전", r.last_sign_in_at ? fmtDateTime(r.last_sign_in_at) : "",
      ])));

    adminAlerts();
  }

  // 관리자: 목표 대학 입시 정보 알림 신청
  async function adminAlerts() {
    const box = $("#admAlerts");
    if (!box) return;
    const { data, error } = await sb().rpc("admin_list_target_alerts");
    show(box);
    if (error) {
      msg($("#alMsg"), error.code === "PGRST202"
        ? "알림 기능용 데이터베이스 설정(20261001010000_target_alerts.sql)이 아직 적용되지 않았습니다."
        : `알림 신청 목록을 불러오지 못했습니다. (${error.code || ""} ${error.message || ""})`);
      return;
    }
    const rows = data || [];
    const sel = $("#alUniv");
    const counts = {};
    rows.forEach((r) => { counts[r.univ] = (counts[r.univ] || 0) + 1; });
    ALERT_UNIVS.filter((u) => counts[u]).forEach((u) => {
      const o = document.createElement("option");
      o.value = u;
      o.textContent = `${u} (${counts[u]})`;
      sel.append(o);
    });
    const body = $("#alRows");
    let shown = rows;
    function render() {
      shown = rows.filter((r) => !sel.value || r.univ === sel.value);
      body.replaceChildren(...shown.map((r) => {
        const tr = document.createElement("tr");
        [r.univ, r.track || "-", r.name || "-", r.email || "-", r.member_type || "-", r.grade || "-", fmtDate(r.created_at)]
          .forEach((v) => {
            const td = document.createElement("td");
            td.textContent = v;
            if (v === "-") td.className = "muted";
            tr.append(td);
          });
        return tr;
      }));
      if (!shown.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 7;
        td.className = "adm-empty";
        td.textContent = "아직 알림 신청이 없습니다.";
        tr.append(td);
        body.append(tr);
      }
      const people = new Set(rows.map((r) => r.email)).size;
      $("#alCount").textContent = `${shown.length.toLocaleString("ko-KR")}건 표시 중 (전체 ${rows.length.toLocaleString("ko-KR")}건 · ${people.toLocaleString("ko-KR")}명)`;
    }
    sel.addEventListener("change", render);
    render();
    $("#alCsv").addEventListener("click", () => downloadCsv("snucoach-target-alerts",
      ["대학", "계열", "이름", "이메일", "회원 구분", "학년", "신청일시"],
      shown.map((r) => [r.univ, r.track, r.name, r.email, r.member_type, r.grade, fmtDateTime(r.created_at)])));
  }

  // CSV: 엑셀 수식으로 해석될 수 있는 값(=, +, -, @ 로 시작)은 앞에 ' 를 붙여 무력화한다
  function downloadCsv(name, head, rows) {
    const cell = (v) => {
      let s = v == null ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [head, ...rows].map((r) => r.map(cell).join(","));
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `${name}-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ─────────────────────────────────────────────────────────
  function stop(text, kind) {
    msg($("#authMsg"), text, kind);
    show($("#pageLoading"), false);
    if (PAGE === "reset") show($("#reqCard"));
    $$("form input, form select, form button, [data-oauth]").forEach((el) => { el.disabled = true; });
  }
  const problem = configProblem();
  const libOk = !!(window.supabase && typeof window.supabase.createClient === "function");

  // ── 목표 대학 입시 정보 알림 (대학 라인 잡기·마이페이지 공용) ──
  // 인서울 주요 대학만 대상(DB 의 target_alerts.univ 허용 목록과 같아야 함)
  const ALERT_UNIVS = ["서울대", "연세대", "고려대", "서강대", "성균관대", "한양대", "중앙대", "경희대", "한국외국어대",
    "서울시립대", "이화여대", "건국대", "동국대", "홍익대", "국민대", "숭실대", "세종대", "광운대"];
  const PENDING_KEY = "snucoach-alert-pending"; // 로그인 전에 고른 알림 대학(로그인 뒤 저장하고 지움)
  const alerts = {
    UNIVS: ALERT_UNIVS,
    eligible: (u) => ALERT_UNIVS.includes(u),
    setPending(list) { tryDo(() => localStorage.setItem(PENDING_KEY, JSON.stringify(list))); },
    getPending() { return tryDo(() => JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"), []) || []; },
    clearPending() { tryDo(() => localStorage.removeItem(PENDING_KEY)); },
    async signedIn() { const { data } = await sb().auth.getSession(); return !!data.session; },
    async save(list) { // [{univ, track}] → 이미 신청한 대학은 건너뜀
      const rows = list.filter((x) => x && ALERT_UNIVS.includes(x.univ))
        .map((x) => ({ univ: x.univ, track: x.track ? String(x.track).slice(0, 40) : null }));
      if (!rows.length) return { error: null, count: 0 };
      const { error } = await sb().from("target_alerts").upsert(rows, { onConflict: "user_id,univ", ignoreDuplicates: true });
      return { error, count: error ? 0 : rows.length };
    },
    async flushPending() { // 로그인돼 있으면 보류된 신청을 저장. 저장한 대학 이름 목록을 돌려줌
      const list = alerts.getPending();
      if (!list.length || !(await alerts.signedIn())) return [];
      const { error } = await alerts.save(list);
      if (error) return [];
      alerts.clearPending();
      return list.map((x) => x.univ).filter((u) => ALERT_UNIVS.includes(u));
    },
    async list() { return sb().from("target_alerts").select("univ, track, created_at").order("created_at"); },
    async remove(univ) { return sb().from("target_alerts").delete().eq("univ", univ); },
  };
  window.SnucoachAuth = { ok: !problem && libOk, alerts };
  if (!PAGE) return; // 회원 페이지가 아니면(대학 라인 잡기 등) 도구만 내놓고 끝

  if (problem === "missing") { stop("회원 기능을 준비하고 있습니다. 문의는 카카오톡 채널로 부탁드립니다.", "info"); return; }
  if (problem === "secret") {
    console.error("[스누코치] auth-config.js 에 비밀 키가 들어 있습니다. Supabase 에서 즉시 키를 폐기·재발급하고 Publishable key 로 바꾸세요.");
    stop("보안 설정 오류로 회원 기능을 멈췄습니다. 관리자에게 알려 주세요.");
    return;
  }
  if (!libOk) {
    stop("회원 기능을 불러오지 못했습니다. 새로고침해 주세요.");
    return;
  }
  const pages = { login: pageLogin, signup: pageSignup, reset: pageReset, account: pageAccount, admin: pageAdmin };
  if (pages[PAGE]) {
    pages[PAGE]().catch((e) => {
      console.error(e);
      stop(errText(e));
    });
  }
})();
