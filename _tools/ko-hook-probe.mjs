// Probe where Twitch fetches HLS: page fetch vs worker. Injects at document-start.
import { writeFileSync, mkdirSync } from 'node:fs';
const PORT = process.env.KO_GUEST_PORT || '9333';
const URL_ = process.argv[2] || 'https://www.twitch.tv/rodil';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
mkdirSync('G:/Temp/opencode/tw-probe', { recursive: true });

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.handlers = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id); clearTimeout(timer); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) for (const cb of this.handlers.get(m.method)) cb(m.params, m.sessionId);
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
const bc = await cdp.send('Target.createBrowserContext', { disposeOnDetach: false });
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: bc.browserContextId });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const logs = [];
const workers = [];
cdp.on('Runtime.consoleAPICalled', (p, s) => {
  const t = p.args.map(a => a.value ?? a.description).join(' ');
  if (t.startsWith('KOPROBE')) { logs.push(t); console.log('PAGE', t.slice(0, 200)); }
});
cdp.on('Target.attachedToTarget', async (p, parent) => {
  console.log('ATTACHED', p.targetInfo.type, p.targetInfo.url.slice(0, 100));
  if (p.targetInfo.type === 'worker') workers.push(p.targetInfo.url);
  try {
    await cdp.send('Runtime.enable', {}, p.sessionId);
    await cdp.send('Network.enable', {}, p.sessionId);
  } catch {}
});
await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
await cdp.send('Page.enable', {}, sessionId);
const hook = `(() => {
  const rf = window.fetch;
  window.fetch = function(u, o) {
    try {
      const s = typeof u === 'string' ? u : (u && u.url) || '';
      if (s.includes('m3u8') || s.includes('usher') || s.includes('/playlist/')) console.log('KOPROBE page-fetch', s.slice(0, 150));
    } catch {}
    return rf.apply(this, arguments);
  };
  const OW = window.Worker;
  window.Worker = class extends OW {
    constructor(u, o) {
      try { console.log('KOPROBE new Worker', String(u).slice(0, 130)); } catch {}
      super(u, o);
    }
  };
  const ox = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, u) {
    try { const s = String(u); if (s.includes('m3u8') || s.includes('usher') || s.includes('/playlist/')) console.log('KOPROBE page-xhr', s.slice(0, 150)); } catch {}
    return ox.apply(this, arguments);
  };
})();`;
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: hook }, sessionId);
await cdp.send('Page.navigate', { url: URL_ }, sessionId);
await sleep(18000);
writeFileSync('G:/Temp/opencode/tw-probe/result.json', JSON.stringify({ logs, workers }, null, 2));
console.log('--- summary ---');
console.log('page-fetch m3u8:', logs.filter(x => x.includes('page-fetch') && x.includes('m3u8')).length);
console.log('page-fetch usher:', logs.filter(x => x.includes('page-fetch') && x.includes('usher')).length);
console.log('page-fetch playlist:', logs.filter(x => x.includes('page-fetch') && x.includes('/playlist/')).length);
console.log('workers:', workers.length);
cdp.ws.close(); process.exit(0);
