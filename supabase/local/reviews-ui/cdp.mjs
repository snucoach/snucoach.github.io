// 헤드리스 크롬을 CDP 로 직접 조작하는 최소 도구(Playwright 가 없어 대신 씀)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function launch(profileDir) {
  fs.rmSync(profileDir, { recursive: true, force: true });
  const proc = spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-extensions', 'about:blank'],
    { stdio: 'ignore' });
  let port = null;
  for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { port = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch (e) {} }
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0; const wait = new Map(); const handlers = [];
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) { const { ok, no } = wait.get(d.id); wait.delete(d.id); d.error ? no(new Error(JSON.stringify(d.error))) : ok(d.result); }
    else handlers.forEach((h) => h(d));
  });
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => { const id = ++seq; wait.set(id, { ok, no }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  async function page({ width = 1280, height = 900, mobile = false } = {}) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    const pg = { errors: [], csp: [], dialogs: [] };
    handlers.push((d) => {
      if (d.sessionId !== sessionId) return;
      if (d.method === 'Runtime.exceptionThrown') pg.errors.push(d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text);
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') { const t = d.params.args.map((a) => a.value || a.description || '').join(' '); (/CSP violation/.test(t) ? pg.csp : pg.errors).push(t); }
      if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') { const t = d.params.entry.text; (/Content Security Policy/.test(t) ? pg.csp : pg.errors).push(t + ' ' + (d.params.entry.url || '')); }
      if (d.method === 'Page.javascriptDialogOpening') { pg.dialogs.push(d.params.message); s('Page.handleJavaScriptDialog', { accept: true }); }
    });
    await s('Page.enable'); await s('Runtime.enable'); await s('Log.enable');
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await s('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI));` });
    pg.ev = async (expr) => {
      const r = await s('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text) + '\n' + expr);
      return r.result.value;
    };
    pg.goto = async (url) => {
      const loaded = new Promise((ok) => { const h = (d) => { if (d.sessionId === sessionId && d.method === 'Page.loadEventFired') { handlers.splice(handlers.indexOf(h), 1); ok(); } }; handlers.push(h); });
      await s('Page.navigate', { url }); await loaded; await sleep(150);
    };
    pg.waitFor = async (expr, ms = 5000) => { const t0 = Date.now(); for (;;) { const v = await pg.ev(`return (${expr});`).catch(() => false); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting: ' + expr); await sleep(50); } };
    pg.shot = async (file, full = true) => { const r = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); };
    pg.key = async (key) => { for (const type of ['keyDown', 'keyUp']) await s('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: ({ Enter: 13, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32 })[key] || 0, text: key === 'Enter' && type === 'keyDown' ? '\r' : undefined }); };
    pg.close = () => send('Target.closeTarget', { targetId });
    return pg;
  }
  return { page, close: async () => { try { await send('Browser.close'); } catch (e) {} proc.kill(); } };
}
export { sleep };
