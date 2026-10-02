// 회원 후기 화면 검증용 정적 서버 + 가짜 Supabase(메모리). 운영 Supabase 로는 아무것도 보내지 않는다.
// ui.mjs 가 띄운다(직접 실행할 일은 없다).
//  - 저장소 파일은 그대로 내려 주고, auth-config.js(주소를 이 서버로)와 Supabase 라이브러리(가짜, 아래 fakeSupabase)만 바꿔 준다.
//  - /rest/v1/reviews_public · /rest/v1/rpc/review_hidden_stats : 후기 페이지가 fetch 로 직접 읽는 공개 조회
//  - /__fake/op : 가짜 라이브러리가 보내는 회원·관리자 요청(DB 트리거·RLS 규칙을 흉내 낸다)
//  - /old/… : "브라우저에 남은 옛 화면"(HTML 만 origin/main 것)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const PORT = Number(process.env.PORT || 8766);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const CONFIG = (empty) => (empty ? 'window.SNUCOACH_AUTH = Object.freeze({ url: "", key: "", google: false, kakao: false });'
  : `window.SNUCOACH_AUTH = Object.freeze({ url: "http://127.0.0.1:${PORT}", key: "sb_publishable_fake_for_local_check", google: true, kakao: false });`);

// reviews.js 의 실제 정리 함수를 잘라 쓴다(DB 트리거가 같은 정리를 하는 것을 흉내)
const js = fs.readFileSync(path.join(ROOT, 'assets/js/reviews.js'), 'utf8');
const { cleanBody } = new Function(js.slice(js.indexOf('// ── 순수 함수(시작)'), js.indexOf('// ── 순수 함수(끝)')) + '\nreturn { cleanBody };')();
const label = (name) => { for (const ch of String(name || '').trim()) { const n = ch.codePointAt(0); if ((n >= 44032 && n <= 55203) || (n >= 65 && n <= 90) || (n >= 97 && n <= 122) || (n >= 48 && n <= 57) || (n >= 19968 && n <= 40959) || (n >= 12353 && n <= 12438) || (n >= 12449 && n <= 12538)) return ch.toUpperCase() + '**'; } return '회원'; };
const PROGRAMS = ['학습코칭', '생기부 컨설팅', '무료 자료·이벤트', '기타'];
const REASONS = ['욕설·인신공격', '광고·스팸', '개인정보 노출', '허위 사실·권리 침해', '법령 위반', '임시 조치(권리 침해 신고)'];
const NOTE_REQUIRED = ['법령 위반', '임시 조치(권리 침해 신고)'];
const NOTICES = ['숨김 안내', '해제 결과 안내', '이의 검토 결과 안내'];
const held = (uid) => (db.holds[uid] && Date.parse(db.holds[uid]) > Date.now() ? db.holds[uid] : null);
const E = (code, message) => ({ data: null, error: { code, message } });

// 검증용 가짜 Supabase 클라이언트(브라우저에서 실행된다). 로그인 상태·프로필은 localStorage(__fake_state)에서,
// 후기·관리자 요청은 이 서버의 /__fake/op 로 보낸다. 실제 Supabase 로는 아무것도 보내지 않는다.
// 따로 .js 파일로 두지 않고 이 함수의 글자를 그대로 내려 준다: 저장소 파일은 GitHub Pages 로 그대로 공개되므로,
// 운영 사이트와 같은 출처에 「브라우저가 실행할 수 있는 가짜 클라이언트 파일」이 놓이지 않게 한다(이 .mjs 는 브라우저에서 실행되지 않는다).
function fakeSupabase() {
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
}

let db;
function reset(init = {}) {
  db = { seq: 0, reviews: [], users: {}, quota: {}, holds: {}, log: [], mode: 'ok', statsMode: 'ok', emptyConfig: false, fnMissing: false, requests: [], failNext: null, ...init };
  db.reviews = (init.reviews || []).map((r) => ({ verified: false, verified_at: null, hidden_at: null, hidden_reason: null, hidden_note: null, ...r }));
  db.seq = Math.max(0, ...db.reviews.map((r) => r.id));
}
reset();
const pub = (r) => ({ id: r.id, rating: r.rating, program: r.program, body: r.body, author: r.author_label, verified: r.verified, created_at: r.created_at, updated_at: r.updated_at });
const now = () => new Date().toISOString();

function op({ uid, kind, name, args = {}, row, filters = {} }) {
  const u = uid ? db.users[uid] : null;
  if (db.failNext && db.failNext.kind === kind && (!db.failNext.name || db.failNext.name === name)) { const e = db.failNext.error; db.failNext = null; return { data: null, error: e }; }
  const isAdmin = !!(u && u.is_admin);
  if (kind === 'rpc') {
    if (db.fnMissing && /review/.test(name)) return E('PGRST202', `Could not find the function public.${name} in the schema cache`);
    if (name === 'my_review_status') {
      if (!u) return E('42501', 'permission denied');
      const state = !u.complete ? 'onboarding' : u.is_admin ? 'admin' : u.banned ? 'banned' : held(uid) ? 'hold' : 'ok';
      return { data: [{ state, author: state === 'ok' || state === 'hold' ? label(u.name) : null, hold_until: state === 'hold' ? held(uid) : null }], error: null };
    }
    if (name === 'my_reviews') {
      if (!u) return E('42501', 'permission denied');
      return { data: db.reviews.filter((r) => r.user_id === uid).sort((a, b) => b.id - a.id).map((r) => ({ ...pub(r), hidden: !!r.hidden_at, hidden_reason: r.hidden_reason, hidden_detail: r.hidden_note || null, hidden_at: r.hidden_at || null })), error: null };
    }
    if (name === 'admin_list_reviews') {
      if (!isAdmin) return E('42501', '관리자만 볼 수 있습니다.');
      return { data: db.reviews.slice().sort((a, b) => b.id - a.id).map((r) => { const w = db.users[r.user_id] || {}; const { user_id, ...rest } = r; const sent = db.log.filter((l) => l.review_id === r.id && l.action === 'notify' && r.hidden_at && l.at >= r.hidden_at).map((l) => l.at).sort().pop() || null;
        return { ...rest, name: w.name, email: w.email, member_type: w.member_type, banned: !!w.banned, notified_at: sent }; }), error: null };
    }
    if (name === 'admin_set_review_hidden') {
      if (!isAdmin) return E('42501', '관리자만 할 수 있습니다.');
      const r = db.reviews.find((x) => x.id === args.p_id);
      if (!r) return E('RV004', '후기를 찾을 수 없습니다. 작성자가 지웠을 수 있습니다.');
      if (r.user_id === uid) return E('RV008', '본인 계정으로 쓴 후기는 직접 처리할 수 없습니다.');
      const note = String(args.p_note || '').trim().slice(0, 300) || null;
      if (args.p_hidden) {
        if (!REASONS.includes(args.p_reason)) return E('23514', '숨김 사유를 골라 주세요.');
        if (NOTE_REQUIRED.includes(args.p_reason) && (note || '').length < 2) return E('23514', '이 사유는 메모에 구체 사유를 적어 주세요.');
        db.log.push({ at: now(), review_id: r.id, action: r.hidden_at ? 'reason' : 'hide', rating: r.rating, program: r.program, reason: args.p_reason, note, admin_email: u.email, deleted: false });
        r.hidden_at = r.hidden_at || now(); r.hidden_reason = args.p_reason; r.hidden_note = note;
      } else if (r.hidden_at) {
        db.log.push({ at: now(), review_id: r.id, action: 'unhide', rating: r.rating, program: r.program, reason: r.hidden_reason, note, admin_email: u.email, deleted: false });
        r.hidden_at = null; r.hidden_reason = null; r.hidden_note = null;
      }
      return { data: null, error: null };
    }
    if (name === 'admin_set_review_verified') {
      if (!isAdmin) return E('42501', '관리자만 할 수 있습니다.');
      const r = db.reviews.find((x) => x.id === args.p_id);
      if (!r) return E('RV004', '후기를 찾을 수 없습니다. 작성자가 지웠을 수 있습니다.');
      if (r.user_id === uid) return E('RV008', '본인 계정으로 쓴 후기는 직접 처리할 수 없습니다.');
      if (args.p_verified && !['학습코칭', '생기부 컨설팅'].includes(r.program)) return E('23514', '수강 확인은 학습코칭·생기부 컨설팅 후기에만 붙일 수 있습니다.');
      if (r.verified !== !!args.p_verified) db.log.push({ at: now(), review_id: r.id, action: args.p_verified ? 'verify' : 'unverify', rating: r.rating, program: r.program, reason: null, note: null, admin_email: u.email, deleted: false });
      r.verified = !!args.p_verified; r.verified_at = r.verified ? (r.verified_at || now()) : null;
      return { data: null, error: null };
    }
    if (name === 'admin_log_review_notice') {
      if (!isAdmin) return E('42501', '관리자만 할 수 있습니다.');
      if (!NOTICES.includes(args.p_kind)) return E('23514', '어떤 안내를 보냈는지 골라 주세요.');
      const r = db.reviews.find((x) => x.id === args.p_id);
      if (!r) return E('RV004', '후기를 찾을 수 없습니다. 작성자가 지웠을 수 있습니다.');
      db.log.push({ at: now(), review_id: r.id, action: 'notify', rating: r.rating, program: r.program, reason: r.hidden_reason, note: args.p_kind, admin_email: u.email, deleted: false });
      return { data: null, error: null };
    }
    if (name === 'admin_list_review_log') return isAdmin ? { data: db.log.slice().reverse(), error: null } : E('42501', '관리자만 볼 수 있습니다.');
    if (name === 'admin_list_members') return isAdmin ? { data: db.members || [], error: null } : E('42501', '관리자만 볼 수 있습니다.');
    if (name === 'admin_list_target_alerts') return isAdmin ? { data: [], error: null } : E('42501', '관리자만 볼 수 있습니다.');
    return E('PGRST202', `Could not find the function public.${name} in the schema cache`);
  }
  if (kind === 'reviews.insert' || kind === 'reviews.update') {
    if (!u) return E('42501', 'permission denied for table reviews');
    for (const k of Object.keys(row)) if (!['rating', 'program', 'body'].includes(k)) return E('42501', 'permission denied for table reviews');
    const old = kind === 'reviews.update' ? db.reviews.find((r) => r.id === Number(filters.id) && r.user_id === uid) : null;
    if (kind === 'reviews.update' && !old) return { data: null, error: null };
    if (kind === 'reviews.insert') {
      if (u.is_admin) return E('RV003', '관리자 계정으로는 후기를 쓸 수 없습니다.');
      if (u.banned) return E('RV005', '후기 작성이 제한된 계정입니다. 이의가 있으면 카카오톡 채널로 알려 주세요.');
      if (held(uid)) return E('RV007', `숨김 처리된 후기를 지운 뒤 14일 동안은 새 후기를 올릴 수 없습니다(${held(uid).slice(0, 16).replace('T', ' ')} 까지).`);
      if (!u.complete) return E('RV002', '가입 마무리를 끝낸 뒤 후기를 남길 수 있습니다.');
    } else if (u.is_admin) return E('RV003', '관리자 계정으로는 후기를 고칠 수 없습니다.');
    else if (u.banned) return E('RV005', '후기 작성이 제한된 계정입니다. 이의가 있으면 카카오톡 채널로 알려 주세요.');
    const body = cleanBody(row.body);
    if (!(Number(row.rating) >= 1 && Number(row.rating) <= 5)) return E('23514', 'new row for relation "reviews" violates check constraint "reviews_rating_range"');
    if (!PROGRAMS.includes(row.program)) return E('23514', 'new row for relation "reviews" violates check constraint "reviews_program_allowed"');
    const n = Array.from(body).length;
    if (n < 10 || n > 1000) return E('23514', 'new row for relation "reviews" violates check constraint "reviews_body_length"');
    if (db.reviews.some((r) => r.user_id === uid && r.program === row.program && (!old || r.id !== old.id))) return E('23505', 'duplicate key value violates unique constraint "reviews_user_program_key"');
    if (kind === 'reviews.insert') {
      const day = new Date().toISOString().slice(0, 10);
      const q = db.quota[uid] && db.quota[uid].day === day ? db.quota[uid] : { day, n: 0 };
      if (q.n + 1 > 3) return E('RV001', '후기는 하루에 3건까지 쓸 수 있습니다. 내일 다시 시도해 주세요.');
      q.n += 1; db.quota[uid] = q;
      const t = now();
      const r = { id: ++db.seq, user_id: uid, rating: Number(row.rating), program: row.program, body, author_label: label(u.name), verified: false, verified_at: null, hidden_at: null, hidden_reason: null, hidden_note: null, created_at: t, updated_at: t };
      db.reviews.push(r);
      return { data: { id: r.id }, error: null };
    }
    const changed = old.rating !== Number(row.rating) || old.program !== row.program || old.body !== body;
    if (changed) {
      if (old.program !== row.program) { old.verified = false; old.verified_at = null; }
      Object.assign(old, { rating: Number(row.rating), program: row.program, body, author_label: label(u.name), updated_at: now() });
    }
    return { data: { id: old.id }, error: null };
  }
  if (kind === 'reviews.delete') {
    if (!u) return E('42501', 'permission denied for table reviews');
    const i = db.reviews.findIndex((r) => r.id === Number(filters.id) && r.user_id === uid);
    if (i < 0) return { data: null, error: null };
    const [r] = db.reviews.splice(i, 1);
    if (r.hidden_at) db.holds[uid] = new Date(Date.now() + 14 * 86400000).toISOString(); // 숨김 처리된 글을 지우면 14일 보류
    db.log.forEach((l) => { if (l.review_id === r.id) l.deleted = true; });
    return { data: { id: r.id }, error: null };
  }
  return E('PGRST205', 'unknown ' + kind);
}

const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => ok(s)); });
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  const send = (code, body, type, headers = {}) => { res.writeHead(code, { 'content-type': type || 'text/plain', 'cache-control': 'no-store', ...headers }); res.end(body); };
  const json = (code, obj, headers) => send(code, JSON.stringify(obj), 'application/json', headers);
  db.requests.push(`${req.method} ${p}${url.search}`);
  if (p === '/__fake/reset') { reset(JSON.parse((await readBody(req)) || '{}')); return json(200, { ok: true }); }
  if (p === '/__fake/state') return json(200, db);
  if (p === '/__fake/set') { Object.assign(db, JSON.parse(await readBody(req))); return json(200, { ok: true }); }
  if (p === '/__fake/op') return json(200, op(JSON.parse(await readBody(req))));
  if (p === '/rest/v1/reviews_public') {
    if (req.headers.apikey !== 'sb_publishable_fake_for_local_check') return json(401, { message: 'No API key found in request' });
    if (db.mode === 'missing') return json(404, { code: 'PGRST205', message: "Could not find the table 'public.reviews_public' in the schema cache" });
    if (db.mode === 'fail') return json(500, { code: 'XX000', message: 'forced failure' });
    let list = db.reviews.filter((r) => !r.hidden_at).sort((a, b) => b.id - a.id);
    const total = list.length;
    const lt = /^lt\.(\d+)$/.exec(url.searchParams.get('id') || '');
    if (lt) list = list.filter((r) => r.id < Number(lt[1]));
    list = list.slice(0, Number(url.searchParams.get('limit') || 1000));
    const headers = /count=exact/.test(req.headers.prefer || '') ? { 'content-range': `${list.length ? `0-${list.length - 1}` : '*'}/${total}`, 'access-control-expose-headers': 'Content-Range' } : {};
    return json(200, list.map(pub), headers);
  }
  if (p === '/rest/v1/rpc/review_hidden_stats') {
    if (db.statsMode === 'fail') return json(500, { code: 'XX000', message: 'forced failure' });
    const m = {};
    db.reviews.filter((r) => r.hidden_at).forEach((r) => { m[r.hidden_reason] = (m[r.hidden_reason] || 0) + 1; });
    return json(200, Object.keys(m).sort().map((k) => ({ reason: k, n: m[k] })));
  }
  let old = false;
  if (p.startsWith('/old/')) { old = true; p = p.slice(4); }
  if (p.endsWith('/')) p += 'index.html';
  if (p === '/assets/js/auth-config.js') return send(200, CONFIG(db.emptyConfig), TYPES['.js']);
  if (p === '/assets/vendor/supabase-js-2.117.2.js') return send(200, `(${fakeSupabase.toString()})();`, TYPES['.js']);
  if (p === '/blank.html') return send(200, '<!doctype html><meta charset="utf-8"><title>blank</title>', TYPES['.html']);
  if (p === '/frame.html') return send(200, '<!doctype html><meta charset="utf-8"><title>frame</title><iframe id="f" src="/reviews.html" style="width:1000px;height:900px"></iframe>', TYPES['.html']);
  const rel = p.replace(/^\/+/, '');
  if (rel.includes('..')) return send(400, 'bad');
  try {
    if (old && rel.endsWith('.html')) return send(200, execFileSync('git', ['-C', ROOT, 'show', `origin/main:${rel}`]), TYPES['.html']);
    const f = path.join(ROOT, rel);
    return send(200, fs.readFileSync(f), TYPES[path.extname(f)] || 'application/octet-stream');
  } catch (e) { return send(404, 'not found'); }
}).listen(PORT, '127.0.0.1', () => console.log('listening ' + PORT));
