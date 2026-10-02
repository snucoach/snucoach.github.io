// 검증용 가짜 Supabase 클라이언트. 로그인 상태·프로필은 localStorage(__fake_state)에서, 후기·관리자 요청은 같은 서버의 /__fake/op 로 보낸다.
// 실제 Supabase 로는 아무것도 보내지 않는다.
(function () {
  const KEY = "__fake_state";
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null") || {}; } catch (e) { return {}; } };
  const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));
  const log = (name, arg) => { const s = load(); (s.calls = s.calls || []).push([name, arg]); save(s); };
  const user = (s) => ({ id: s.uid || "u1", email: s.email || "member@example.com", created_at: "2026-10-01T03:00:00Z",
    app_metadata: { provider: s.provider || "email", providers: [s.provider || "email"] }, user_metadata: s.user_metadata || {} });
  async function server(payload) {
    const s = load();
    const res = await fetch("/__fake/op", { method: "POST", body: JSON.stringify({ uid: s.session ? (s.uid || "u1") : null, ...payload }) });
    return res.json();
  }
  async function run(st) {
    const s = load();
    if (st.table === "profiles") {
      if (st.op === "select") { log("profiles.select", st.cols); return { data: s.profile || null, error: null }; }
      if (st.op === "update") { log("profiles.update", st.row); s.profile = { ...s.profile, ...st.row }; save(s); return { data: s.profile, error: null }; }
    }
    if (st.table === "target_alerts") return { data: st.op === "select" ? (s.alerts || []) : null, error: null };
    if (st.table === "reviews") {
      log("reviews." + st.op, { row: st.row, filters: st.filters, cols: st.cols });
      const r = await server({ kind: "reviews." + st.op, row: st.row, filters: st.filters });
      if (st.single && !r.error && !r.data) return { data: null, error: { code: "PGRST116", message: "no rows" } };
      return r;
    }
    if (st.table.startsWith("rpc:")) {
      log(st.table, st.args);
      if (st.table === "rpc:delete_my_account") { const t = load(); t.session = false; t.profile = null; save(t); return { data: null, error: null }; }
      return server({ kind: "rpc", name: st.table.slice(4), args: st.args });
    }
    return { data: null, error: { code: "PGRST205", message: "unknown " + st.table } };
  }
  function builder(table, args) {
    const st = { table, op: "select", filters: {}, args };
    const b = {
      select(cols) { st.cols = cols; return b; }, insert(row) { st.op = "insert"; st.row = row; return b; },
      update(row) { st.op = "update"; st.row = row; return b; },
      upsert(rows) { st.op = "upsert"; st.rows = rows; return b; }, delete() { st.op = "delete"; return b; },
      eq(k, v) { st.filters[k] = v; return b; }, order() { return b; }, range() { return b; },
      maybeSingle() { return b; }, single() { st.single = true; return b; },
      then(res, rej) { return new Promise((r) => setTimeout(r, 5)).then(() => run(st)).then(res, rej); },
    };
    return b;
  }
  window.supabase = {
    createClient() {
      return {
        auth: {
          async initialize() { return { error: null }; },
          async getSession() { const s = load(); return { data: { session: s.session ? { user: user(s), access_token: "fake" } : null } }; },
          async getUser() { const s = load(); return s.session ? { data: { user: user(s) }, error: null } : { data: { user: null }, error: { code: "session_not_found" } }; },
          onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
          async signUp(arg) { log("auth.signUp", { email: arg.email, data: arg.options.data }); return { data: { session: null, user: {} }, error: null }; },
          async signInWithPassword(arg) { log("auth.signIn", { email: arg.email }); const s = load(); s.session = true; save(s); localStorage.setItem("snucoach-auth", JSON.stringify({ refresh_token: "fake", access_token: "fake" })); return { data: {}, error: null }; },
          async signOut() { const s = load(); s.session = false; save(s); return { error: null }; },
          async verifyOtp() { return { error: null }; }, async resend() { return { error: null }; },
          async updateUser() { return { error: null }; }, async signInWithOAuth() { log("auth.oauth", null); return { error: null }; },
          async resetPasswordForEmail() { return { error: null }; },
        },
        from: (t) => builder(t),
        rpc: (fn, args) => builder("rpc:" + fn, args),
      };
    },
  };
})();
