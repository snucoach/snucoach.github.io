// 스누코치 회원 기능 — 로그인 · 회원가입 · 비밀번호 찾기 · 마이페이지 · 관리자 · 회원 후기 도구
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

  // ── 휴대전화 번호: 한국 휴대전화(010 은 11자리, 011·016~019 는 10~11자리). 저장은 숫자만 ──
  // DB 의 profiles_phone_format · 트리거와 같은 규칙이다. 서버로는 항상 normalizePhone() 값을 보낸다.
  const PHONE_RE = /^(010\d{8}|01[16789]\d{7,8})$/;
  const normalizePhone = (v) => String(v == null ? "" : v).replace(/\D/g, "").replace(/^820?(1[016789])/, "0$1");
  const PHONE_EMPTY = "휴대전화 번호를 입력해 주세요.";
  const PHONE_INVALID = "휴대전화 번호를 정확히 입력해 주세요. (예: 010-1234-5678)";
  const PHONE_NEEDED = "휴대전화 번호를 입력하면 켤 수 있습니다.";
  const phoneProblem = (v) => {
    const d = normalizePhone(v);
    return !d ? PHONE_EMPTY : PHONE_RE.test(d) ? "" : PHONE_INVALID;
  };
  const fmtPhone = (v) => { // 화면·CSV 표시용: 010-1234-5678
    const d = normalizePhone(v);
    return PHONE_RE.test(d) ? d.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-$2-$3") : (v || "");
  };
  // 프로필 행에 그 열이 있는지. 휴대전화용 DB 설정(20261002000000_phone.sql) 적용 전이면 false → 번호 관련 화면을 숨긴다.
  // 번호는 프로필 행(profiles.phone)에서만 읽는다. 로그인 정보(user_metadata)의 값은 쓰지 않는다.
  const hasCol = (row, col) => !!row && Object.prototype.hasOwnProperty.call(row, col);
  const needsPhone = (p) => hasCol(p, "phone") && !p.phone;

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
    "23514": "입력한 내용을 다시 확인해 주세요.",
    PGRST204: "지금은 저장할 수 없습니다. 잠시 뒤 다시 시도해 주세요.",
    "42703": "지금은 저장할 수 없습니다. 잠시 뒤 다시 시도해 주세요.",
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
  // 서버(DB CHECK)가 번호 형식을 거절한 경우
  const isPhoneFormatErr = (e) => !!e && e.code === "23514" && /profiles_phone_format/.test(e.message || "");
  // 마케팅 정보(광고성 정보) 수신 동의·철회 처리 결과(전송자 · 처리 일자 · 내용)
  const mktResult = (iso, channel, agreed) => `스누코치는 ${fmtDate(iso)}에 회원님의 마케팅 정보(${channel}) 수신 ${agreed ? "동의를" : "동의 철회를"} 처리했습니다.`;
  const optInNote = (p) => { // 가입 완료 안내에 덧붙인다(동의한 채널만)
    const ch = [p.marketing_opt_in && "이메일", p.marketing_sms_opt_in && "문자"].filter(Boolean);
    return ch.length ? " " + mktResult(p.marketing_opt_in ? p.marketing_opt_in_at : p.marketing_sms_opt_in_at, ch.join("·"), true) : "";
  };
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

  // 이름·휴대전화 번호·회원 구분·학년 (회원가입·가입 마무리·내 정보 공통)
  function profileForm(form, prefix) {
    const name = $(`#${prefix}Name`, form);
    const phone = $(`#${prefix}Phone`, form); // 브라우저에 남은 옛 화면에는 없다
    const phoneErr = $(`#${prefix}PhoneErr`, form);
    let phoneOn = !!phone; // 번호를 받고 보내는 상태인지
    const grade = $(`#${prefix}Grade`, form);
    const typeSet = $(`#${prefix}Type`, form);
    const gradeLabel = $("[data-grade-label]", form);
    const radios = $$('input[name="member_type"]', form);
    const syncLabel = () => {
      const t = (radios.find((r) => r.checked) || {}).value;
      gradeLabel.textContent = t === "학부모" ? "자녀 학년" : "학년";
    };
    const gradeErrEl = $(`#${prefix}GradeErr`, form);
    radios.forEach((r) => r.addEventListener("change", () => {
      syncLabel();
      typeSet.classList.remove("is-invalid");
      $(`#${prefix}TypeErr`, form).textContent = "";
    }));
    // 칸을 벗어날 때 형식이 맞으면 010-1234-5678 꼴로 보여 준다(입력 중에는 건드리지 않는다)
    if (phone) phone.addEventListener("blur", () => { if (!phoneProblem(phone.value)) phone.value = fmtPhone(phone.value); });
    return {
      fill(p) {
        name.value = p.name || "";
        radios.forEach((r) => { r.checked = r.value === p.member_type; });
        grade.value = GRADES.includes(p.grade) ? p.grade : "";
        syncLabel();
        this.syncPhone(p);
      },
      // 번호 칸만 프로필 행에 맞춘다(이름·구분·학년 칸에 입력해 둔 값은 건드리지 않는다)
      syncPhone(p) {
        if (!phone) return;
        // DB 설정 전이면 받지 않는다. 내 정보(pf)는 번호가 아직 없으면 숨긴다:
        // 기존 회원의 첫 입력은 수집 안내가 있는 카드(#phoneCard)에서만 받는다.
        phoneOn = hasCol(p, "phone") && !(prefix === "pf" && !p.phone);
        phone.closest(".field").hidden = !phoneOn;
        phone.value = phoneOn ? fmtPhone(p.phone) : "";
        setErr(phone, phoneErr, "");
      },
      read() {
        const v = {
          name: name.value.trim(),
          member_type: (radios.find((r) => r.checked) || {}).value || null,
          grade: grade.value || null,
        };
        if (phoneOn) v.phone = normalizePhone(phone.value);
        return v;
      },
      // 첫 번째 잘못된 칸을 돌려준다(없으면 null)
      validate() {
        const v = this.read();
        let first = null;
        const nameErr = !v.name ? "이름을 입력해 주세요." : v.name.length > 20 ? "20자 이하로 입력해 주세요." : "";
        if (!setErr(name, $(`#${prefix}NameErr`, form), nameErr)) first = first || name;
        if (phoneOn && !setErr(phone, phoneErr, phoneProblem(phone.value))) first = first || phone;
        const typeErr = TYPES.includes(v.member_type) ? "" : "회원 구분을 골라 주세요.";
        typeSet.classList.toggle("is-invalid", !!typeErr);
        $(`#${prefix}TypeErr`, form).textContent = typeErr;
        if (typeErr) first = first || radios[0];
        const gradeErr = !GRADES.includes(v.grade) ? "학년을 골라 주세요." : "";
        if (!setErr(grade, gradeErrEl, gradeErr)) first = first || grade;
        return first;
      },
      // 서버가 번호 형식을 거절했을 때 번호 칸에 표시한다
      phoneError(text) { if (phone) { setErr(phone, phoneErr, text); focusEl(phone); } return !!phone; },
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
    if (!/reviews\.html/.test(nextUrl())) tryDo(() => sessionStorage.removeItem(RETURN_KEY)); // 후기 화면에서 온 로그인이 아니면 돌아오기 표시를 지운다
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
      const hasPhone = hasCol(p, "phone");
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
              // 번호 칸이 있는 화면(문구가 ‘이메일·문자’)에서만 번호와 문자 수신 동의를 보낸다
              ...(hasPhone ? { phone: p.phone, marketing_sms: c.marketing } : {}),
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
        const doneConsent = $("#doneConsent"); // 수신 동의 처리 결과 안내
        if (doneConsent && c.marketing) {
          doneConsent.textContent = mktResult(new Date().toISOString(), hasPhone ? "이메일·문자" : "이메일", true);
          show(doneConsent);
        }
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
    let notice = q.get("welcome") ? ["가입이 완료되었습니다. 스누코치 회원이 되신 걸 환영합니다!", "ok", true] : null; // [문구, 종류, 가입 완료 안내인지]
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
      notice = ["이메일 인증이 완료되었습니다. 스누코치 회원이 되신 걸 환영합니다!", "ok", true];
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
    // 후기 화면의 「로그인하고 후기 쓰기」로 들어와 구글·카카오로 로그인한 경우: 후기 화면으로 되돌아간다.
    // 가는 곳은 여기에 고정한다(저장된 값으로 주소를 만들지 않는다). 가입 완료·인증 안내가 있으면 여기에 머문다.
    // 가입 마무리 전이면 마무리를 끝낸 뒤 가입 완료 안내(수신 동의 처리 결과 포함)와 함께 「후기 쓰러 가기」 버튼을 보여 준다.
    const back = tryDo(() => Number(sessionStorage.getItem(RETURN_KEY)), 0);
    tryDo(() => sessionStorage.removeItem(RETURN_KEY));
    const fromReviews = !!back && Date.now() - back < 30 * 60 * 1000 && !alerts.getPending().length; // 보류해 둔 입시 알림이 있으면 이 화면에서 먼저 저장한다
    if (isComplete(profile) && !notice && fromReviews) {
      location.replace("reviews.html#member-reviews");
      return;
    }
    $$("[data-sign-out]").forEach((b) => b.addEventListener("click", () => busy(b, "로그아웃 중…", signOutHere)));

    if (!isComplete(profile)) renderOnboarding(user, profile || {}, fromReviews);
    else renderAccount(user, profile, notice);
  }

  async function signOutHere() {
    await sb().auth.signOut({ scope: "local" });
    location.replace("index.html");
  }

  function renderOnboarding(user, profile, fromReviews) {
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
      const row = { ...p, marketing_opt_in: c.marketing, terms_agreed_at: now, privacy_agreed_at: now, age_confirmed_at: now };
      // 번호를 받은 화면에서만 문자 수신 동의를 함께 기록한다(체크 한 번 = 이메일·문자)
      if (hasCol(p, "phone") && hasCol(profile, "marketing_sms_opt_in")) row.marketing_sms_opt_in = c.marketing;
      await busy($('button[type="submit"]', form), "저장하는 중…", async () => {
        const { data, error } = await sb().from("profiles").update(row).eq("id", user.id).select().maybeSingle();
        if (isPhoneFormatErr(error) && prof.phoneError(PHONE_INVALID)) return;
        if (error || !data) { msg(out, error ? errText(error) : "회원 정보를 찾지 못했습니다. 카카오톡 채널로 문의해 주세요."); return; }
        show(card, false);
        renderAccount(user, data, ["가입이 완료되었습니다. 스누코치 회원이 되신 걸 환영합니다!", "ok", true]);
        if (fromReviews) {
          // 후기 화면에서 가입 마무리를 하러 온 경우: 완료 안내 아래에 돌아가는 버튼을 둔다
          const actions = document.createElement("div");
          actions.className = "msg-actions";
          const a = document.createElement("a");
          a.className = "btn btn-primary btn-sm";
          a.href = "reviews.html#member-reviews";
          a.textContent = "후기 쓰러 가기";
          actions.append(a);
          $("#authMsg").append(actions);
        }
      });
    });
  }

  function renderAccount(user, profile, notice) {
    const out = $("#authMsg");
    if (notice) msg(out, notice[0] + (notice[2] ? optInNote(profile) : ""), notice[1]);
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

    // 저장하고 받은 프로필 행으로 화면 전체를 맞춘다(번호 표시·입력 카드·수신 스위치가 같은 값을 본다).
    // 아래에서 쓰는 새 요소(#acctPhone·#phoneCard·#mktSms… 등)는 브라우저에 남은 옛 화면에는 없으므로 없으면 건너뛴다.
    const acctPhone = $("#acctPhone");
    const phoneCard = $("#phoneCard");
    const painters = [];
    const apply = (p) => {
      const phoneChanged = (p.phone || null) !== (profile.phone || null) || hasCol(p, "phone") !== hasCol(profile, "phone");
      profile = p;
      // 서버의 번호가 바뀐 경우(카드에서 입력, 다른 곳에서 삭제)에만 회원 정보의 번호 칸을 맞춘다
      if (phoneChanged) prof.syncPhone(p);
      if (acctPhone) {
        const on = hasCol(p, "phone");
        acctPhone.textContent = p.phone ? fmtPhone(p.phone) : "입력 전";
        show(acctPhone, on);
        show(acctPhone.previousElementSibling, on);
      }
      show(phoneCard, needsPhone(p));
      painters.forEach((fn) => fn(p));
    };

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
      const row = prof.read();
      // 번호를 바꾸지 않았으면 보내지 않는다(이 화면을 열어 둔 사이 다른 곳에서 지운 번호를 되살리지 않는다)
      if (hasCol(row, "phone") && row.phone === (profile.phone || "")) delete row.phone;
      await busy($('button[type="submit"]', pform), "저장하는 중…", async () => {
        const { data, error } = await sb().from("profiles").update(row).eq("id", user.id).select().maybeSingle();
        if (isPhoneFormatErr(error) && prof.phoneError(PHONE_INVALID)) return;
        if (error || !data) { msg(pout, error ? errText(error) : "저장하지 못했습니다. 다시 로그인해 주세요."); return; }
        apply(data);
        head(data);
        msg(pout, "저장했습니다.", "ok");
      });
    });

    // 마케팅 정보 수신 동의(이메일·문자 따로) — 바꿀 때마다 처리 결과(일자·내용)를 바로 알린다
    const mout = $("#mktMsg");
    const wireSwitch = (toggle, logEl, col, atCol, label, hintEl) => {
      if (!toggle) return;
      painters.push((p) => {
        const locked = !!hintEl && !p.phone; // 문자: 번호가 없으면 켤 수 없다
        toggle.checked = !!p[col];
        toggle.disabled = locked;
        show(hintEl, locked);
        // 숨긴 안내가 화면 낭독기에 계속 읽히지 않도록, 잠겨 있을 때만 설명으로 연결한다
        if (hintEl) { if (locked) toggle.setAttribute("aria-describedby", hintEl.id); else toggle.removeAttribute("aria-describedby"); }
        if (logEl) {
          logEl.textContent = p[atCol]
            ? `${fmtDate(p[atCol])} 수신 ${p[col] ? "동의" : "동의 철회"} 처리됨`
            : locked ? "" : "아직 수신에 동의하지 않았습니다.";
        }
      });
      toggle.addEventListener("change", async () => {
        const want = toggle.checked;
        toggle.disabled = true;
        // 그 채널 열 하나만 보낸다. 한 채널을 꺼도 다른 채널은 바뀌지 않는다.
        const { data, error } = await sb().from("profiles").update({ [col]: want }).eq("id", user.id).select().maybeSingle();
        toggle.disabled = false;
        if (error || !data) { toggle.checked = !want; msg(mout, error ? errText(error) : "저장하지 못했습니다."); return; }
        apply(data);
        if (!!data[col] !== want) { msg(mout, PHONE_NEEDED); return; } // 서버가 번호 없는 문자 동의를 기록하지 않은 경우
        msg(mout, mktResult(data[atCol], label, want), "ok");
      });
    };
    wireSwitch($("#mktToggle"), $("#mktLog"), "marketing_opt_in", "marketing_opt_in_at", "이메일");
    if (hasCol(profile, "marketing_sms_opt_in")) {
      show($("#mktSmsRow"));
      wireSwitch($("#mktSmsToggle"), $("#mktSmsLog"), "marketing_sms_opt_in", "marketing_sms_opt_in_at", "문자", $("#mktSmsHint"));
    }

    // 목표 대학 입시 정보 알림: 신청 목록을 그리고, 로그인 전에 고른 대학이 있으면 저장한다.
    // 휴대전화 번호가 없으면 저장하지 않고, 번호를 입력하면 신청된다고 알린다(이미 신청한 알림의 목록·해제는 그대로 된다).
    const aout = $("#alertMsg");
    const drawAlerts = async () => {
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
          await drawAlerts();
        }));
        li.append(t, b);
        return li;
      }));
      show($("#alertEmpty"), !(data || []).length);
    };
    const flushAndDraw = async () => {
      const note = $("#alertNeedPhone");
      if (needsPhone(profile)) {
        const pend = alerts.getPending().map((x) => x && x.univ).filter((u) => ALERT_UNIVS.includes(u));
        if (note) note.textContent = pend.length ? `고른 대학(${pend.join("·")})의 알림은 위에서 휴대전화 번호를 입력하면 신청됩니다.` : "";
        show(note, !!pend.length);
      } else {
        show(note, false);
        const saved = await alerts.flushPending();
        const left = alerts.getPending().map((x) => x && x.univ).filter((u) => ALERT_UNIVS.includes(u));
        if (saved.length) msg(aout, `${saved.join("·")} 입시 정보 알림을 신청했습니다.`, "ok");
        // 저장하지 못해 보류가 남은 경우: 조용히 넘어가지 않고 알린다(보류는 남겨 두어 다음에 다시 신청한다)
        else if (left.length) msg(aout, `고른 대학(${left.join("·")})의 알림을 신청하지 못했습니다. 잠시 뒤 이 페이지를 새로고침하면 다시 신청합니다.`);
      }
      await drawAlerts();
    };

    // 기존 회원: 휴대전화 번호 입력 카드(수집 안내와 함께 받는다). 입력 전에도 마이페이지의 다른 기능은 그대로 쓸 수 있다.
    if (phoneCard) {
      const pf2 = $("#phoneForm");
      const tel = $("#phTel");
      const telErr = $("#phTelErr");
      const sms = $("#phSms");
      const pmsg = $("#phoneMsg");
      const smsOn = hasCol(profile, "marketing_sms_opt_in");
      show($("#phSmsRow"), smsOn);
      tel.addEventListener("blur", () => { if (!phoneProblem(tel.value)) tel.value = fmtPhone(tel.value); });
      pf2.addEventListener("submit", async (e) => {
        e.preventDefault();
        msg(pmsg, "");
        if (!setErr(tel, telErr, phoneProblem(tel.value))) { focusEl(tel); return; }
        const row = { phone: normalizePhone(tel.value) };
        if (smsOn && sms.checked) row.marketing_sms_opt_in = true;
        await busy($('button[type="submit"]', pf2), "저장하는 중…", async () => {
          const { data, error } = await sb().from("profiles").update(row).eq("id", user.id).select().maybeSingle();
          if (isPhoneFormatErr(error)) { setErr(tel, telErr, PHONE_INVALID); focusEl(tel); return; }
          if (error || !data) { msg(pmsg, error ? errText(error) : "저장하지 못했습니다. 다시 로그인해 주세요."); return; }
          apply(data); // 카드가 사라지고 번호 표시·문자 스위치가 풀리며, 회원 정보에 번호 칸이 나타난다(다른 칸의 입력은 그대로 둔다)
          msg(out, "휴대전화 번호를 저장했습니다." + (row.marketing_sms_opt_in && data.marketing_sms_opt_in
            ? " " + mktResult(data.marketing_sms_opt_in_at, "문자", true) : ""), "ok");
          out.setAttribute("tabindex", "-1"); // 카드가 사라지므로 초점을 안내문으로 옮긴다
          focusEl(out);
          await flushAndDraw(); // 번호가 없어 미뤄 둔 알림 신청
        });
      });
    }
    apply(profile);

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

    flushAndDraw();

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

    // 휴대전화용 DB 설정 전이면 목록에 phone 열이 없다 → 새 칸은 '-' 로 두고 안내한다
    const phoneReady = !rows.length || hasCol(rows[0], "phone");
    if (!phoneReady) msg(out, "휴대전화 번호용 데이터베이스 설정(20261002000000_phone.sql)이 아직 적용되지 않았습니다.", "info");
    // 발송 대상: 그 채널 수신에 동의했고 이메일 인증과 가입 마무리를 끝낸 회원.
    // 번호는 인증하지 않고 받으므로, 메일 인증 전 계정의 동의는 본인 것인지 확인되지 않았다(남의 번호·이메일일 수 있다).
    const status = (r) => (!r.email_confirmed ? "메일 인증 전" : !r.profile_completed ? "가입 마무리 전" : "");
    const emailTarget = (r) => !!r.marketing_opt_in && r.email_confirmed && r.profile_completed;
    const smsTarget = (r) => !!r.marketing_sms_opt_in && !!r.phone && r.email_confirmed && r.profile_completed;
    // 표·CSV 의 수신 동의 칸: 발송 대상이 아닌 동의는 「동의(메일 인증 전)」처럼 구분해 적는다
    const optCell = (on, target, r, at) => (!on ? "" : target ? "동의" : `동의(${status(r) || "휴대전화 번호 없음"})`) + (on && at ? ` (${at})` : "");
    const count = (fn) => rows.filter(fn).length;
    const stats = [
      ["전체 회원", rows.length],
      ["학생", count((r) => r.member_type === "학생")],
      ["학부모", count((r) => r.member_type === "학부모")],
      ["기타", count((r) => r.member_type === "기타")],
      ["가입 마무리 전", count((r) => !r.profile_completed || !r.email_confirmed)],
      ["휴대전화 번호 미입력", phoneReady ? count((r) => r.profile_completed && !r.phone) : "-"],
      ["이메일 수신 동의", count(emailTarget)],
      ["문자 수신 동의", phoneReady ? count(smsTarget) : "-"],
    ];
    $("#admStats").replaceChildren(...stats.map(([label, n]) => {
      const d = document.createElement("div");
      d.className = "stat";
      const b = document.createElement("b");
      b.textContent = typeof n === "number" ? n.toLocaleString("ko-KR") : n;
      const s = document.createElement("span");
      s.textContent = label;
      d.append(b, s);
      return d;
    }));

    const search = $("#admSearch");
    const onlyMkt = $("#admMkt");
    const onlySms = $("#admSms"); // 브라우저에 남은 옛 화면에는 없다
    const body = $("#admRows");
    const provider = (r) => PROVIDER_NAMES[r.provider] || r.provider;
    // 표의 칸(제목, 값). 제목 줄도 여기서 그린다: 브라우저에 남은 옛 화면(칸 수가 다른 제목 줄)에서도 제목과 값이 어긋나지 않는다.
    const cols = [
      ["가입일", (r) => fmtDate(r.created_at)],
      ["이름", (r) => [r.name, status(r) && `(${status(r)})`].filter(Boolean).join(" ")],
      ["이메일", (r) => r.email],
      ["휴대전화", (r) => (r.phone ? fmtPhone(r.phone) : "")],
      ["구분", (r) => r.member_type],
      ["학년", (r) => r.grade],
      ["이메일 수신", (r) => optCell(r.marketing_opt_in, emailTarget(r), r, fmtDate(r.marketing_opt_in_at))],
      ["문자 수신", (r) => optCell(r.marketing_sms_opt_in, smsTarget(r), r, fmtDate(r.marketing_sms_opt_in_at))],
      ["가입 방식", provider],
      ["최근 로그인", (r) => fmtDateTime(r.last_sign_in_at)],
    ];
    drawHead(body, cols);
    let shown = rows;
    function render() {
      const qv = search.value.trim().toLowerCase();
      // 검색어가 숫자·하이픈·공백·+ 뿐이면 휴대전화 번호로 찾는다(숫자만 비교)
      const qd = /^[\d\s+()-]+$/.test(qv) ? normalizePhone(qv) : "";
      shown = rows.filter((r) => (!onlyMkt.checked || emailTarget(r))
        && (!onlySms || !onlySms.checked || smsTarget(r))
        && (!qv || (r.name || "").toLowerCase().includes(qv) || (r.email || "").toLowerCase().includes(qv)
          || (!!qd && (r.phone || "").includes(qd))));
      drawRows(body, cols, shown, rows.length ? "조건에 맞는 회원이 없습니다." : "아직 회원이 없습니다.");
      $("#admCount").textContent = `${shown.length.toLocaleString("ko-KR")}명 표시 중 (전체 ${rows.length.toLocaleString("ko-KR")}명)`;
    }
    search.addEventListener("input", render);
    onlyMkt.addEventListener("change", render);
    if (onlySms) onlySms.addEventListener("change", render);
    render();

    // CSV 는 화면 필터를 따른다. 휴대전화는 010-1234-5678 꼴(숫자만 내보내면 엑셀에서 앞자리 0 이 사라진다).
    // 발송 대상 칸: 필터 없이 내려받은 파일에서도 보낼 수 있는 회원(동의 + 이메일 인증 + 가입 마무리)만 「대상」으로 적힌다.
    $("#admCsv").addEventListener("click", () => downloadCsv("snucoach-members",
      ["가입일시", "이름", "이메일", "휴대전화", "회원 구분", "학년",
        "이메일 수신 동의", "이메일 발송 대상", "이메일 동의·철회 일시", "문자 수신 동의", "문자 발송 대상", "문자 동의·철회 일시",
        "가입 방식", "이메일 인증", "가입 마무리", "최근 로그인"],
      shown.map((r) => [
        fmtDateTime(r.created_at), r.name, r.email, r.phone ? fmtPhone(r.phone) : "", r.member_type, r.grade,
        optCell(r.marketing_opt_in, emailTarget(r), r) || "미동의", emailTarget(r) ? "대상" : "제외", r.marketing_opt_in_at ? fmtDateTime(r.marketing_opt_in_at) : "",
        optCell(r.marketing_sms_opt_in, smsTarget(r), r) || "미동의", smsTarget(r) ? "대상" : "제외", r.marketing_sms_opt_in_at ? fmtDateTime(r.marketing_sms_opt_in_at) : "",
        provider(r), r.email_confirmed ? "완료" : "전",
        r.profile_completed ? "완료" : "전", r.last_sign_in_at ? fmtDateTime(r.last_sign_in_at) : "",
      ])));

    adminAlerts();
    adminReviews();
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
    // 문자로 보내도 되는 신청인지(sms_ok): 번호를 받은 뒤에 「이메일이나 문자로」 화면에서 신청한 알림만 해당한다.
    // 번호를 받기 전에 신청한 알림(개정 전 신청분 포함)은 이메일로만 보낸다. 휴대전화용 DB 설정 전이면 열이 없다 → '-'.
    const smsWay = (r) => (!hasCol(r, "sms_ok") ? "" : r.sms_ok ? "이메일·문자" : "이메일만");
    const cols = [
      ["대학", (r) => r.univ],
      ["계열", (r) => r.track],
      ["이름", (r) => r.name],
      ["이메일", (r) => r.email],
      ["휴대전화", (r) => (r.phone ? fmtPhone(r.phone) : "")],
      ["보내는 방법", smsWay],
      ["구분", (r) => r.member_type],
      ["학년", (r) => r.grade],
      ["신청일", (r) => fmtDate(r.created_at)],
    ];
    drawHead(body, cols);
    let shown = rows;
    function render() {
      shown = rows.filter((r) => !sel.value || r.univ === sel.value);
      drawRows(body, cols, shown, "아직 알림 신청이 없습니다.");
      const people = new Set(rows.map((r) => r.email)).size;
      $("#alCount").textContent = `${shown.length.toLocaleString("ko-KR")}건 표시 중 (전체 ${rows.length.toLocaleString("ko-KR")}건 · ${people.toLocaleString("ko-KR")}명)`;
    }
    sel.addEventListener("change", render);
    render();
    $("#alCsv").addEventListener("click", () => downloadCsv("snucoach-target-alerts",
      ["대학", "계열", "이름", "이메일", "휴대전화", "보내는 방법", "회원 구분", "학년", "신청일시"],
      shown.map((r) => [r.univ, r.track, r.name, r.email, r.phone ? fmtPhone(r.phone) : "", smsWay(r), r.member_type, r.grade, fmtDateTime(r.created_at)])));
  }

  // 관리자: 회원 후기(숨김·숨김 해제·수강 확인·작성자 알림 기록). DB: supabase/migrations/20261003000000_reviews.sql
  async function adminReviews() {
    const box = $("#admReviews");
    if (!box) return; // 브라우저에 남은 옛 화면
    const out = $("#rvMsg");
    const body = $("#rvRows");
    const stateSel = $("#rvState");
    const search = $("#rvSearch");
    const dlg = $("#rvHideDlg");
    const reason = $("#rvHideReason");
    const reasonErr = $("#rvHideReasonErr");
    const noteEl = $("#rvHideNote");
    const noteErr = $("#rvHideNoteErr");
    const dlgMsg = $("#rvHideMsg");
    let rows = [];
    let shown = [];
    let target = null;
    let opener = null; // 숨김 창을 연 버튼(창을 닫으면 초점을 돌려준다)
    const DAY = 86400000;
    const mdDate = (iso) => new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", timeZone: "Asia/Seoul" }).format(new Date(iso));
    const edited = (r) => Date.parse(r.updated_at) !== Date.parse(r.created_at);
    const dayCount = (iso) => Math.max(1, Math.floor((Date.now() - Date.parse(iso)) / DAY) + 1);
    const tempUntil = (r) => Date.parse(r.hidden_at) + TEMP_DAYS * DAY; // 임시 조치 기한
    const tempAuto = (r) => Date.parse(r.hidden_at) + TEMP_AUTO_DAYS * DAY; // 이 시각이 지나면 다음 정리 작업이 다시 게시한다
    const tempLeft = (r) => Math.ceil((tempAuto(r) - Date.now()) / DAY);
    const rpcErr = (error) => (error.code === "RV004" ? "후기를 찾을 수 없습니다. 작성자가 지웠을 수 있습니다."
      : error.code === "RV008" || /본인 계정으로 쓴 후기/.test(error.message || "") ? "본인 계정으로 쓴 후기는 직접 처리할 수 없습니다."
        : error.code === "42501" ? "관리자만 할 수 있습니다. 관리자로 지정한 계정으로 로그인했는지 확인해 주세요."
          : error.code === "23514" && error.message ? error.message
            : `처리하지 못했습니다. (${error.code || ""} ${error.message || ""})`);

    // 다시 살펴볼 글에 붙는 표시(상태 칸에 적고, 「확인할 글」 필터로 모아 본다)
    //  - 숨긴 뒤 작성자가 고친 글: 다시 보고 기준에 해당하지 않으면 숨김을 해제한다(약관 제10조 제7항)
    //  - 다른 후기를 숨긴 뒤 같은 회원이 올리거나 고친 글: 숨긴 내용을 옮겨 적지 않았는지 본다
    //  - 임시 조치 기한이 7일 이내로 남은 글, 작성자에게 알렸다는 기록이 없는 숨김 글
    let flagsOf = new Map();
    function computeFlags() {
      const firstHide = new Map(); // 이메일 → 그 회원의 글 가운데 가장 먼저 숨긴 시각
      rows.forEach((r) => {
        if (!r.hidden_at || !r.email) return;
        const t = Date.parse(r.hidden_at);
        if (!firstHide.has(r.email) || t < firstHide.get(r.email)) firstHide.set(r.email, t);
      });
      flagsOf = new Map(rows.map((r) => {
        const f = [];
        if (r.hidden_at) {
          if (Date.parse(r.updated_at) > Date.parse(r.hidden_at)) f.push(`숨긴 뒤 작성자가 고침(${mdDate(r.updated_at)}). 다시 확인해 주세요`);
          if (r.hidden_reason === HIDE_TEMP && tempLeft(r) <= 7) f.push(tempLeft(r) > 1 ? `임시 조치 글이 ${tempLeft(r)}일 뒤 자동으로 다시 게시됩니다` : "임시 조치 글이 곧 자동으로 다시 게시됩니다");
          if (!r.notified_at) f.push("작성자 알림 기록 없음");
        } else if (r.email && firstHide.has(r.email) && Date.parse(r.updated_at) > firstHide.get(r.email)) {
          f.push("이 회원의 다른 후기를 숨긴 뒤에 올리거나 고친 글");
        }
        return [r.id, f];
      }));
    }
    const flags = (r) => flagsOf.get(r.id) || [];

    async function load() {
      const list = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb().rpc("admin_list_reviews").range(from, from + 999);
        if (error) {
          show(box);
          const missing = error.code === "PGRST202";
          msg(out, missing
            ? "회원 후기용 데이터베이스 설정(20261003000000_reviews.sql)이 아직 적용되지 않았습니다."
            : `후기 목록을 불러오지 못했습니다. (${error.code || ""} ${error.message || ""})`, missing ? "info" : "error");
          show($("#rvBody"), false);
          return false;
        }
        list.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      rows = list;
      computeFlags();
      show(box);
      show($("#rvBody"));
      render();
      return true;
    }

    // 작성자에게 보내는 안내 메일. 메일 앱이 열리고, 보내는 것은 관리자가 직접 한다. 보낸 뒤 「알림 기록」으로 남긴다.
    //   hide: 숨김 안내(사유와 이의 제기 방법. 임시 조치는 기한 포함) · unhide: 해제 결과 · keep: 이의 검토 결과(숨김 유지)
    const KAKAO_URL = "https://pf.kakao.com/_wiwxmG/chat";
    function mailHref(r, kind, why, detail) {
      const what = `${fmtDate(r.created_at)}에 올리신 후기(${r.program}, 글 번호 ${r.id})`;
      const detailLine = detail ? [`구체 사유: ${detail}`] : [];
      const temp = why === HIDE_TEMP;
      let subject;
      let lines;
      if (kind === "unhide") {
        subject = "[스누코치] 후기 다시 게시 안내";
        lines = [
          `회원님이 ${what}의 숨김 처리를 해제하여 다시 게시했음을 알려 드립니다.`,
          "",
          `- 후기 페이지: ${site("reviews.html#member-reviews")}`,
          `- 운영 기준: ${site("terms.html#reviews")}`,
        ];
      } else if (kind === "keep") {
        subject = "[스누코치] 후기 숨김 처리 이의 검토 결과";
        lines = [
          `회원님이 ${what}의 숨김 처리에 대해 알려 주신 내용을 확인했습니다. 확인한 결과 이 후기가 회원 후기 운영 기준(${why})에 해당하여 숨김 처리를 유지함을 알려 드립니다.`,
          ...detailLine,
          "",
          "- 해당하는 부분을 고친 뒤 알려 주시면 다시 확인해, 기준에 해당하지 않으면 다시 게시합니다.",
          `- 더 알리실 내용이 있으면 이 메일에 답장하거나 카카오톡 채널(${KAKAO_URL})로 알려 주세요.`,
          `- 운영 기준: ${site("terms.html#reviews")}`,
        ];
      } else if (temp) {
        subject = "[스누코치] 후기 임시 조치 안내";
        lines = [
          `회원님이 ${what}로 권리를 침해당했다는 신고가 접수되어, 이용약관 제10조 제8항에 따라 ${mdDate(new Date(tempUntil(r)).toISOString())}까지 임시로 숨김 처리했음을 알려 드립니다(임시 조치). 그동안 다른 사람에게는 보이지 않습니다.`,
          ...detailLine,
          "",
          "- 스누코치는 이 기간에 양쪽의 설명을 확인해 다시 게시할지 정하고 결과를 알려 드립니다. 그때까지 정하지 못하면 다시 게시합니다.",
          `- 의견이나 설명할 자료가 있으면 이 메일에 답장하거나 카카오톡 채널(${KAKAO_URL})로 알려 주세요.`,
          "- 후기 페이지의 「내가 쓴 후기」에서 내용을 고치거나 지울 수 있습니다. 숨김 처리된 후기를 지우면 14일 동안 새 후기를 올릴 수 없습니다.",
          `- 운영 기준: ${site("terms.html#reviews")}`,
        ];
      } else {
        subject = "[스누코치] 후기 숨김 처리 안내";
        lines = [
          `회원님이 ${what}가 회원 후기 운영 기준(${why})에 따라 숨김 처리되어 다른 사람에게 보이지 않게 되었음을 알려 드립니다.`,
          ...detailLine,
          "",
          "- 후기 페이지의 「내가 쓴 후기」에서 숨김 사유를 확인하고 내용을 고치거나 지울 수 있습니다. 숨김 처리된 후기를 지우면 14일 동안 새 후기를 올릴 수 없습니다.",
          `- 내용을 고쳤거나 숨김 처리에 이의가 있으면 이 메일에 답장하거나 카카오톡 채널(${KAKAO_URL})로 알려 주세요. 확인한 뒤 운영 기준에 해당하지 않으면 다시 게시하고 결과를 알려 드립니다.`,
          `- 운영 기준: ${site("terms.html#reviews")}`,
        ];
      }
      const text = ["안녕하세요, 스누코치입니다.", "", ...lines, "", "스누코치 드림"].join("\r\n");
      return `mailto:${encodeURIComponent(r.email || "").replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
    }
    function mailLink(r, kind, label) {
      const a = document.createElement("a");
      a.className = "btn btn-line btn-sm";
      a.href = mailHref(r, kind, r.hidden_reason, r.hidden_note);
      a.textContent = label;
      return a;
    }
    const button = (label, fn, cls) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls || "btn btn-line btn-sm";
      b.textContent = label;
      b.addEventListener("click", () => fn(b));
      return b;
    };
    // 처리 결과 안내 아래에 붙이는 버튼 줄: 메일 쓰기 + 「알림 보냄으로 기록」
    function noticeActions(r, kind, noticeKind, mailLabel) {
      const wrap = document.createElement("div");
      wrap.className = "msg-actions";
      wrap.append(mailLink(r, kind, mailLabel), button("알림 보냄으로 기록", (b) => busy(b, "기록하는 중…", () => logNotice(r, noticeKind))));
      return wrap;
    }
    async function logNotice(r, noticeKind) {
      return call("admin_log_review_notice", { p_id: r.id, p_kind: noticeKind }, `「${noticeKind}」을 보냈다고 처리 기록에 남겼습니다.`);
    }

    async function call(fn, args, okText) {
      const { error } = await sb().rpc(fn, args);
      if (error) {
        if (error.code === "RV004") await load();
        msg(out, error.code === "PGRST202" ? "데이터베이스 설정(20261003000000_reviews.sql)을 다시 실행해 주세요. 이 기능은 새 판에 들어 있습니다." : rpcErr(error));
        focusEl(out);
        return false;
      }
      await load();
      msg(out, okText, "ok");
      focusEl(out);
      return true;
    }

    function actions(r) {
      const wrap = document.createElement("div");
      wrap.className = "adm-acts";
      const back = () => { wrap.replaceChildren(...normal()); focusEl(wrap.querySelector("button")); };
      // window.confirm 대신 한 번 더 누르게 한다
      const confirmIn = (text, okLabel, fn) => {
        const q = document.createElement("span");
        q.className = "adm-confirm";
        q.textContent = text;
        const no = button("그만두기", back);
        wrap.replaceChildren(q, button(okLabel, (b) => busy(b, "처리 중…", fn), "btn btn-danger btn-sm"), no);
        focusEl(no);
      };
      const normal = () => {
        const list = [];
        if (REVIEW_VERIFIABLE.includes(r.program)) {
          list.push(r.verified
            ? button("확인 취소", () => confirmIn("착오로 붙인 수강 확인만 취소합니다. 취소할까요?", "확인 취소",
              () => call("admin_set_review_verified", { p_id: r.id, p_verified: false }, "수강 확인을 취소했습니다.")))
            : button("수강 확인", (b) => busy(b, "처리 중…",
              () => call("admin_set_review_verified", { p_id: r.id, p_verified: true }, "수강 확인 표시를 붙였습니다."))));
        }
        if (r.hidden_at) {
          list.push(
            button("숨김 해제", () => confirmIn("다시 게시할까요?", "다시 게시", async () => {
              const done = await call("admin_set_review_hidden", { p_id: r.id, p_hidden: false }, "숨김을 해제해 다시 게시했습니다. 작성자에게 결과를 알려 주세요.");
              if (done) { out.append(noticeActions(r, "unhide", "해제 결과 안내", "작성자에게 결과 메일 쓰기")); focusEl(out); }
            })),
            button("사유 고치기", (b) => openHide(r, b)),
            mailLink(r, "hide", "작성자에게 알리기"),
            mailLink(r, "keep", "이의 결과 메일"),
            // 어떤 안내를 보냈는지 골라 기록한다
            button("알림 기록", () => {
              const q = document.createElement("span");
              q.className = "adm-confirm";
              q.textContent = "작성자에게 보낸 안내를 골라 주세요. 처리 기록에 남습니다.";
              const no = button("그만두기", back);
              wrap.replaceChildren(q,
                button("숨김 안내", (b) => busy(b, "기록하는 중…", () => logNotice(r, "숨김 안내"))),
                button("이의 검토 결과 안내", (b) => busy(b, "기록하는 중…", () => logNotice(r, "이의 검토 결과 안내"))),
                no);
              focusEl(no);
            }),
          );
        } else {
          list.push(button("숨김", (b) => openHide(r, b)));
        }
        return list;
      };
      wrap.append(...normal());
      return wrap;
    }

    // 상태 칸: 숨김 여부·사유·메모·기간, 임시 조치 기한, 작성자 알림 기록, 다시 살펴볼 표시
    function statusCell(r) {
      const d = document.createElement("div");
      d.className = "adm-status";
      const lines = [];
      if (r.hidden_at) {
        lines.push(`숨김 · ${r.hidden_reason}`);
        if (r.hidden_note) lines.push(r.hidden_note);
        lines.push(`${mdDate(r.hidden_at)}부터 ${dayCount(r.hidden_at)}일째`);
        if (r.hidden_reason === HIDE_TEMP) lines.push(`임시 조치 기한 ${mdDate(new Date(tempUntil(r)).toISOString())} · ${mdDate(new Date(tempAuto(r)).toISOString())} 이후 자동 재게시`);
        if (r.notified_at) lines.push(`작성자 알림 ${mdDate(r.notified_at)} 기록`);
      } else {
        lines.push("게시 중");
      }
      d.textContent = lines.join("\n");
      flags(r).forEach((t) => {
        const f = document.createElement("span");
        f.className = "adm-flag";
        f.textContent = t;
        d.append(f);
      });
      return d;
    }
    const memberCell = (r) => {
      const n = r.email ? rows.filter((x) => x.email === r.email).length : 0;
      return [[r.name, r.member_type].filter(Boolean).join(" · "), r.email, n > 1 && `이 회원의 후기 ${n}건`, r.banned && "작성 제한"].filter(Boolean).join("\n");
    };

    // 「관리」를 번호 바로 다음에 둔다(표가 넓어 맨 끝에 두면 가로로 밀어야 버튼이 보인다)
    const cols = [
      ["번호", (r) => String(r.id)],
      ["관리", actions],
      ["상태", statusCell, "lines"],
      ["작성일", (r) => fmtDate(r.created_at) + (edited(r) ? `\n수정 ${mdDate(r.updated_at)}` : ""), "lines"],
      ["별점", (r) => String(r.rating)],
      ["프로그램", (r) => r.program],
      ["본문", (r) => { const d = document.createElement("div"); d.className = "adm-body"; d.textContent = r.body; return d; }, "wrap"],
      ["표시 이름", (r) => r.author_label],
      ["회원", memberCell, "lines"],
      ["수강 확인", (r) => (r.verified ? `확인 (${mdDate(r.verified_at)})` : "")],
    ];
    drawHead(body, cols);
    function render() {
      const qv = search.value.trim().toLowerCase();
      const st = stateSel.value;
      shown = rows.filter((r) => (!st || (st === "check" ? flags(r).length > 0 : (st === "hidden") === !!r.hidden_at))
        && (!qv || String(r.id) === qv || [r.name, r.email, r.body, r.author_label, r.program].some((v) => (v || "").toLowerCase().includes(qv))));
      drawRows(body, cols, shown, rows.length ? "조건에 맞는 후기가 없습니다." : "아직 회원 후기가 없습니다.");
      const n = (x) => x.toLocaleString("ko-KR");
      const hidden = rows.filter((r) => r.hidden_at);
      const check = rows.filter((r) => flags(r).length).length;
      $("#rvCount").textContent = `${n(shown.length)}건 표시 중 (전체 ${n(rows.length)}건 · 게시 중 ${n(rows.length - hidden.length)} · 숨김 ${n(hidden.length)} · 수강 확인 ${n(rows.filter((r) => r.verified).length)} · 확인할 글 ${n(check)})`;
      // 숨긴 글이 낮은 별점에 쏠려 있지 않은지 스스로 점검하는 줄
      const dist = $("#rvDist");
      dist.textContent = hidden.length
        ? `숨긴 글의 별점: ${[1, 2, 3, 4, 5].map((s) => `${s}점 ${n(hidden.filter((r) => r.rating === s).length)}`).join(" · ")} / 게시 중인 글의 별점: ${[1, 2, 3, 4, 5].map((s) => `${s}점 ${n(rows.filter((r) => !r.hidden_at && r.rating === s).length)}`).join(" · ")}`
        : "";
      show(dist, !!hidden.length);
    }
    stateSel.addEventListener("change", render);
    search.addEventListener("input", render);

    // 숨김 창
    const NOTE_NEEDED = "이 사유는 메모에 구체 사유를 적어 주세요.";
    const syncNote = () => {
      const need = HIDE_NOTE_REQUIRED.includes(reason.value);
      $("#rvHideNoteOpt").textContent = need ? "(필수)" : "(선택)";
      if (!need) setErr(noteEl, noteErr, "");
    };
    reason.addEventListener("change", () => { if (reason.value) setErr(reason, reasonErr, ""); syncNote(); });
    function openHide(r, from) {
      target = r;
      opener = from || null;
      $("#rvHideTitle").textContent = r.hidden_at ? "숨김 사유 고치기" : "후기 숨김";
      $("#rvHideOk").textContent = r.hidden_at ? "사유 저장" : "숨김 처리";
      $("#rvHideBody").textContent = `글 번호 ${r.id} · 별점 ${r.rating}점 · ${r.program} · ${r.author_label}\n${r.body}`;
      reason.value = HIDE_REASONS.includes(r.hidden_reason) ? r.hidden_reason : "";
      noteEl.value = r.hidden_note || "";
      setErr(reason, reasonErr, "");
      setErr(noteEl, noteErr, "");
      msg(dlgMsg, "");
      syncNote();
      dlg.showModal();
      focusEl(reason);
    }
    $("#rvHideCancel").addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => { if (opener && opener.isConnected) focusEl(opener); });
    $("#rvHideOk").addEventListener("click", async (e) => {
      if (!target) return;
      const why = reason.value;
      const detail = noteEl.value.trim();
      let bad = null;
      if (!setErr(reason, reasonErr, HIDE_REASONS.includes(why) ? "" : "숨김 사유를 골라 주세요.")) bad = reason;
      if (!setErr(noteEl, noteErr, HIDE_NOTE_REQUIRED.includes(why) && detail.length < 2 ? NOTE_NEEDED : "")) bad = bad || noteEl;
      if (bad) { focusEl(bad); return; }
      await busy(e.currentTarget, "처리 중…", async () => {
        const r = target;
        const first = !r.hidden_at;
        const { error } = await sb().rpc("admin_set_review_hidden", { p_id: r.id, p_hidden: true, p_reason: why, p_note: detail || null });
        if (error) { msg(dlgMsg, rpcErr(error)); return; }
        dlg.close();
        await load();
        // 숨긴 날 작성자에게 사유와 이의 제기 방법을 알린다(약관 제10조)
        msg(out, first ? "숨김 처리했습니다. 오늘 안에 작성자에게 사유와 이의 제기 방법을 알리고, 보낸 뒤 「알림 보냄으로 기록」을 눌러 주세요."
          : "숨김 사유를 고쳤습니다. 작성자에게 알린 사유와 달라졌다면 다시 알려 주세요.", "ok");
        const now = rows.find((x) => x.id === r.id) || { ...r, hidden_at: new Date().toISOString() };
        out.append(noticeActions({ ...now, hidden_reason: why, hidden_note: detail }, "hide", "숨김 안내", "작성자에게 메일 쓰기"));
        focusEl(out);
      });
    });

    // CSV: 화면 필터를 따른다
    $("#rvCsv").addEventListener("click", () => downloadCsv("snucoach-reviews",
      ["글 번호", "작성일시", "수정일시", "상태", "숨김 사유", "숨김 메모", "숨김 일시", "작성자 알림 기록", "확인할 점", "별점", "프로그램", "본문", "표시 이름", "이름", "이메일", "회원 구분", "수강 확인", "수강 확인 일시", "작성 제한"],
      shown.map((r) => [r.id, fmtDateTime(r.created_at), edited(r) ? fmtDateTime(r.updated_at) : "", r.hidden_at ? "숨김" : "게시 중", r.hidden_reason, r.hidden_note,
        r.hidden_at ? fmtDateTime(r.hidden_at) : "", r.notified_at ? fmtDateTime(r.notified_at) : "", flags(r).join(" / "), r.rating, r.program, r.body, r.author_label, r.name, r.email, r.member_type,
        r.verified ? "확인" : "", r.verified_at ? fmtDateTime(r.verified_at) : "", r.banned ? "제한" : ""])));
    // 처리 기록: 숨김·사유 수정·해제·수강 확인·작성자 알림을 처리한 내역(작성자·본문 없음). 글이 지워진 뒤에도 남는다.
    const ACTIONS = { hide: "숨김", reason: "사유 수정", unhide: "숨김 해제", verify: "수강 확인", unverify: "수강 확인 취소", notify: "작성자 알림" };
    $("#rvLogCsv").addEventListener("click", (e) => busy(e.currentTarget, "불러오는 중…", async () => {
      const list = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb().rpc("admin_list_review_log").range(from, from + 999);
        if (error) { msg(out, `처리 기록을 불러오지 못했습니다. (${error.code || ""} ${error.message || ""})`); focusEl(out); return; }
        list.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      downloadCsv("snucoach-review-log",
        ["처리 일시", "글 번호", "처리", "별점", "프로그램", "사유", "메모", "처리한 관리자", "후기"],
        list.map((l) => [fmtDateTime(l.at), l.review_id, ACTIONS[l.action] || l.action, l.rating, l.program, l.reason, l.note, l.admin_email || (l.action === "unhide" ? "(자동)" : ""), l.deleted ? "지워짐" : "남아 있음"]));
    }));

    await load();
  }

  // 관리자 표: 제목 줄과 본문을 같은 칸 정의([제목, 값, 칸 클래스])로 그린다. 빈 값은 '-'(흐리게). 값이 Node 면 그대로 붙인다.
  function drawHead(tbody, cols) {
    const head = tbody.closest("table").tHead;
    if (!head || !head.rows[0]) return;
    head.rows[0].replaceChildren(...cols.map(([label]) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      return th;
    }));
  }
  function drawRows(tbody, cols, list, emptyText) {
    tbody.replaceChildren(...list.map((r) => {
      const tr = document.createElement("tr");
      cols.forEach(([, value, cls]) => {
        const td = document.createElement("td");
        const v = value(r);
        if (cls) td.className = cls;
        if (v instanceof Node) td.append(v);
        else {
          td.textContent = v || "-";
          if (!v) td.classList.add("muted");
        }
        tr.append(td);
      });
      return tr;
    }));
    if (!list.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = cols.length;
      td.className = "adm-empty";
      td.textContent = emptyText;
      tr.append(td);
      tbody.append(tr);
    }
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
    phone: { normalize: normalizePhone, problem: phoneProblem, format: fmtPhone },
    // 알림을 저장해도 되는 상태인지: "ok" | "signed-out" | "onboarding"(가입 마무리 전) | "phone"(번호 없음) | "error"
    // 열 이름을 지정하지 않고 읽는다(select *): 휴대전화용 DB 설정 전에도 오류 없이 "ok" 가 된다.
    async gate() {
      const { data } = await sb().auth.getSession();
      if (!data.session) return { state: "signed-out" };
      const { data: row, error } = await sb().from("profiles").select("*").eq("id", data.session.user.id).maybeSingle();
      if (error) return { state: "error", error };
      if (!isComplete(row)) return { state: "onboarding" };
      return { state: needsPhone(row) ? "phone" : "ok" };
    },
    // 알림 신청 창에서 받은 휴대전화 번호 저장. 실패하면 { error: { code, message } }
    async savePhone(raw) {
      const bad = phoneProblem(raw);
      if (bad) return { error: { code: "phone_invalid", message: bad } };
      const { data } = await sb().auth.getSession();
      if (!data.session) return { error: { code: "signed_out", message: "다시 로그인해 주세요." } };
      const { data: row, error } = await sb().from("profiles").update({ phone: normalizePhone(raw) }).eq("id", data.session.user.id).select("id").maybeSingle();
      if (error) return { error: { code: error.code, message: isPhoneFormatErr(error) ? PHONE_INVALID : errText(error) } };
      return { error: row ? null : { code: "not_found", message: "저장하지 못했습니다. 다시 로그인해 주세요." } };
    },
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
      if ((await alerts.gate()).state !== "ok") return []; // 가입 마무리·번호 입력 전이면 보류를 지우지 않고 둔다
      const { error } = await alerts.save(list);
      if (error) return [];
      alerts.clearPending();
      return list.map((x) => x.univ).filter((u) => ALERT_UNIVS.includes(u));
    },
    async list() { return sb().from("target_alerts").select("univ, track, created_at").order("created_at"); },
    async remove(univ) { return sb().from("target_alerts").delete().eq("univ", univ); },
  };

  // ── 회원 후기 (후기 페이지·관리자 화면 공용). DB: supabase/migrations/20261003000000_reviews.sql ──
  const REVIEW_PROGRAMS = ["학습코칭", "생기부 컨설팅", "무료 자료·이벤트", "기타"]; // DB 의 reviews_program_allowed 와 같아야 함
  const REVIEW_VERIFIABLE = ["학습코칭", "생기부 컨설팅"]; // 수강 확인을 붙일 수 있는 프로그램(DB 의 reviews_verified_program)
  // 숨김 사유. DB 의 reviews_hidden_consistent 와 같아야 한다. 이름은 약관 제10조 제5항 각 호(와 제8항의 임시 조치)에 맞췄다.
  const HIDE_REASONS = ["욕설·인신공격", "광고·스팸", "개인정보 노출", "허위 사실·권리 침해", "법령 위반", "임시 조치(권리 침해 신고)"];
  const HIDE_NOTE_REQUIRED = ["법령 위반", "임시 조치(권리 침해 신고)"]; // 메모(구체 사유)가 필수인 사유
  const HIDE_TEMP = "임시 조치(권리 침해 신고)";
  const TEMP_DAYS = 30; // 임시 조치 기간(약관 제10조 제8항)
  const TEMP_AUTO_DAYS = 29; // DB 의 정리 작업은 숨긴 지 29일이 지나면 자동으로 다시 게시한다(reviews.sql 의 purge_review_records)
  const RETURN_KEY = "snucoach-return"; // 후기 화면에서 로그인하러 온 표시(같은 탭에서만, 30분). reviews.js 가 적는다
  // 서버가 직접 정한 코드(RV…)는 메시지로도 판정한다(실제 API 가 코드를 그대로 돌려주는지 미리 확인하지 못했다)
  const reviewErrText = (e) => {
    if (!e) return "";
    const m = e.message || "";
    if (e.code === "RV001" || /하루에 3건/.test(m)) return "후기는 하루에 3건까지 올릴 수 있습니다. 내일 다시 시도해 주세요.";
    if (e.code === "RV002" || /가입 마무리/.test(m)) return "가입 마무리를 끝낸 뒤 후기를 남길 수 있습니다.";
    if (e.code === "RV003" || /관리자 계정으로는/.test(m)) return "관리자 계정으로는 후기를 쓰거나 고칠 수 없습니다.";
    if (e.code === "RV005" || /제한된 계정/.test(m)) return "후기 작성이 제한된 계정입니다. 이의가 있으면 카카오톡 채널로 알려 주세요.";
    if (e.code === "RV006" || /하루에 20번/.test(m)) return "후기는 하루에 20번까지 고칠 수 있습니다. 내일 다시 시도해 주세요.";
    if (e.code === "RV007" || /14일 동안/.test(m)) return "숨김 처리된 후기를 지운 뒤 14일 동안은 새 후기를 올릴 수 없습니다. 이미 올린 후기는 고칠 수 있습니다.";
    if (e.code === "23505") return "이 프로그램에는 이미 후기를 남기셨습니다. 「내가 쓴 후기」에서 고칠 수 있습니다.";
    if (e.code === "23514" && /reviews_body_length/.test(m)) return "후기 내용은 10자 이상 1,000자 이하로 적어 주세요.";
    if (["PGRST205", "PGRST202", "42P01", "PGRST204", "42703"].includes(e.code)) return "지금은 후기를 올릴 수 없습니다. 잠시 뒤 다시 시도해 주세요.";
    if (e.code === "not_found") return "후기를 찾을 수 없습니다. 새로고침해 주세요.";
    return errText(e);
  };
  const reviews = {
    PROGRAMS: REVIEW_PROGRAMS,
    errText: reviewErrText,
    // 후기를 쓸 수 있는 상태인지: "ok" | "signed-out" | "onboarding"(가입 마무리 전) | "admin" | "banned"(작성 제한)
    //                             | "hold"(숨김 처리된 글을 지운 뒤의 새 글 보류. holdUntil 까지) | "error"
    // author 는 지금 쓰면 붙는 표시 이름(예: 김**). 프로필(실명 등)은 이 화면으로 읽어 오지 않는다.
    async status() {
      const { data } = await sb().auth.getSession();
      if (!data.session) return { state: "signed-out" };
      const { data: rows, error } = await sb().rpc("my_review_status");
      if (error) return { state: /^PGRST30[1-3]$/.test(error.code || "") ? "signed-out" : "error", error };
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row || !["ok", "onboarding", "admin", "banned", "hold"].includes(row.state)) return { state: "error", error: { code: "empty" } };
      return { state: row.state, author: row.author || "", holdUntil: row.hold_until || "" };
    },
    async mine() { return sb().rpc("my_reviews"); },
    // 넣는 칸은 세 개뿐이다. select("id") 를 빼면 안 된다(전체 칸을 돌려 달라고 하면 열 권한 때문에 42501 이 된다).
    async create(v) { return sb().from("reviews").insert({ rating: v.rating, program: v.program, body: v.body }).select("id").single(); },
    async update(id, v) {
      const { data, error } = await sb().from("reviews").update({ rating: v.rating, program: v.program, body: v.body }).eq("id", id).select("id").maybeSingle();
      return { data, error: error || (data ? null : { code: "not_found" }) };
    },
    async remove(id) {
      const { data, error } = await sb().from("reviews").delete().eq("id", id).select("id").maybeSingle();
      return { data, error: error || (data ? null : { code: "not_found" }) };
    },
  };
  window.SnucoachAuth = { ok: !problem && libOk, alerts, reviews };
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
