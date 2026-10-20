// Generic CDP evaluator for the isolated guest Chrome (port 9333).
// Usage: node ko-eval.mjs <url-regex> <script-file-or-expression> [--context=ko|page] [--wait=ms]
import { readFileSync } from 'node:fs';
const PORT = process.env.KO_GUEST_PORT || '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const urlRe = new RegExp(process.argv[2] || '.', 'i');
const exprArg = process.argv[3] || '1+1';
const mode = (process.argv.find(a => a.startsWith('--context=')) || '--context=ko').split('=')[1];
const wait = Number((process.argv.find(a => a.startsWith('--wait=')) || '--wait=0').split('=')[1]);
let expression = exprArg;
if (!/[\n;()=]/.test(exprArg) && /\.(mjs|js)$/.test(exprArg)) expression = readFileSync(exprArg, 'utf8');
else if (!/[\n;()=]/.test(exprArg) && !/^[0-9'"`]/.test(exprArg)) { try { expression = readFileSync(exprArg, 'utf8'); } catch {} }

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

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const cdp = new CDP(version.webSocketDebuggerUrl);
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = pages.find(t => t.type === 'page' && urlRe.test(t.url || ''));
if (!page) { console.error('page not found; pages:', pages.map(p => p.url)); process.exit(1); }
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
const contexts = [];
cdp.on('Runtime.executionContextCreated', p => contexts.push(p.context));
await cdp.send('Runtime.enable', {}, sessionId);
if (wait) await sleep(wait);
const ext = contexts.find(c => (c.origin || '').startsWith('chrome-extension://') && (c.auxData?.type === 'isolated' || !c.auxData));
const pageCtx = contexts.find(c => c.auxData?.isDefault || (c.origin || '').startsWith('https://'));
const ctx = mode === 'page' ? pageCtx : (ext || pageCtx);
if (!ctx) { console.error('no context', contexts.map(c => c.origin)); process.exit(1); }
const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, contextId: ctx.id }, sessionId);
if (r.exceptionDetails) console.error('EXCEPTION', JSON.stringify(r.exceptionDetails).slice(0, 2000));
console.log(JSON.stringify(r.result?.value ?? r.result, null, 2));
cdp.ws.close();
