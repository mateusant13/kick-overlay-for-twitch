// Real user-style click on an element in the guest Chrome, then report KO state.
// Usage: node ko-click.mjs <url-regex> <css-selector> [waitMs]
const PORT = process.env.KO_GUEST_PORT || '9333';
const urlRe = new RegExp(process.argv[2] || '.', 'i');
const selector = process.argv[3] || '#ko-golive';
const waitMs = Number(process.argv[4] || 8000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.handlers = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id); clearTimeout(timer); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) for (const cb of this.handlers.get(m.method)) cb(m.params);
    };
  }
  async send(method, params = {}, sessionId, timeout = 30000) {
    await this.ready; const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ': timeout')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  on(method, cb) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(cb); }
}

const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const cdp = new CDP(v.webSocketDebuggerUrl);
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = pages.find(t => t.type === 'page' && urlRe.test(t.url || ''));
if (!page) { console.error('page not found', pages.map(p => p.url)); process.exit(1); }
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
const ctxs = [];
cdp.on('Runtime.executionContextCreated', p => ctxs.push(p.context));
await cdp.send('Runtime.enable', {}, sessionId);
await sleep(300);
const ext = ctxs.find(c => (c.origin || '').startsWith('chrome-extension://') && c.auxData?.type === 'isolated');
const pageCtx = ctxs.find(c => c.auxData?.isDefault);
async function ev(expr, contextId) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, contextId }, sessionId);
  if (r.exceptionDetails) console.error('EVAL EXC', JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result?.value;
}
const rect = await ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return null; const s = getComputedStyle(b); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, display: s.display, pe: s.pointerEvents, text: b.textContent }; })()`, pageCtx.id);
console.log('RECT', rect);
if (!rect || rect.w === 0 || rect.h === 0) { console.error('not clickable'); process.exit(2); }
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' }, sessionId);
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId);
console.log('CLICKED', rect.x, rect.y);
await sleep(waitMs);
if (ext) {
  const after = await ev('({onDvr: (typeof KO!=="undefined"?KO.kickOnDvr:null), pos:(typeof KO!=="undefined"?KO.kickState.pos:null), state:(typeof KO!=="undefined"?KO.kickState.state:null), liveUrl:(typeof KO!=="undefined"?String(KO.activeUrl||"").slice(0,90):null)})', ext.id);
  console.log('AFTER', after);
}
cdp.ws.close();
