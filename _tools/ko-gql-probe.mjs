// Probe: does the page's GQL PlaybackAccessToken request control ad playlist?
import { writeFileSync, mkdirSync } from 'node:fs';
const PORT = '9333';
const URL_ = process.argv[2] || 'https://www.twitch.tv/rodil';
const FORCE = process.argv[3] || 'embed';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
mkdirSync('G:/Temp/opencode/tw-gql', { recursive: true });

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
const media = [];
cdp.on('Runtime.consoleAPICalled', (p) => {
  const t = p.args.map(a => a.value ?? a.description).join(' ');
  if (t.startsWith('KOPROBE')) { logs.push(t); console.log(t.slice(0, 220)); }
});
cdp.on('Target.attachedToTarget', async (p) => {
  try { await cdp.send('Runtime.enable', {}, p.sessionId); await cdp.send('Network.enable', {}, p.sessionId); } catch {}
});
cdp.on('Network.requestWillBeSent', (p) => {
  if (String(p.request.url).includes('/playlist/')) media.push({ url: p.request.url, id: p.requestId });
});
cdp.on('Network.loadingFinished', async (p, s) => {
  const m = media.find(x => x.id === p.requestId);
  if (!m) return;
  try {
    const b = await cdp.send('Network.getResponseBody', { requestId: p.requestId }, s);
    const t = b.base64Encoded ? Buffer.from(b.body, 'base64').toString() : b.body;
    m.text = t;
    console.log('MEDIA', t.length, 'ad=', /stitched|X-TV-TWITCH-AD-URL/i.test(t), 'nonLive=', (t.match(/^#EXTINF:[^\n]*$/gm)||[]).filter(x=>!x.includes(',live')).length);
  } catch {}
});
await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
await cdp.send('Network.enable', {}, sessionId);
await cdp.send('Page.enable', {}, sessionId);
const hook = `(() => {
  console.log('KOPROBE hook installed');
  const patch = (body) => {
    try {
      const j = JSON.parse(body); const arr = Array.isArray(j) ? j : [j]; let changed = false;
      for (const x of arr) {
        const v = x && x.variables;
        if (v && (v.playerType || String(x.operationName || '').includes('PlaybackAccessToken'))) {
          console.log('KOPROBE gql', x.operationName || '', 'playerType=', v.playerType, 'platform=', v.platform);
          if (v.playerType) { v.playerType = '${FORCE}'; changed = true; }
          if (v.platform) { v.platform = 'web'; }
        }
      }
      return changed ? JSON.stringify(j) : body;
    } catch { return body; }
  };
  const rf = window.fetch;
  window.fetch = function(u, o) {
    try {
      const s = typeof u === 'string' ? u : (u && u.url) || '';
      if (s.includes('gql.twitch.tv/gql') && o && typeof o.body === 'string') {
        o = { ...o, body: patch(o.body) };
      }
    } catch {}
    return rf.call(this, u, o);
  };
  const ox = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u) { this.__koUrl = String(u); return ox.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(b) {
    try { if (String(this.__koUrl).includes('gql.twitch.tv/gql') && typeof b === 'string') arguments[0] = patch(b); } catch {}
    return os.apply(this, arguments);
  };
})();`;
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: hook }, sessionId);
await cdp.send('Page.navigate', { url: URL_ }, sessionId);
await sleep(16000);
writeFileSync('G:/Temp/opencode/tw-gql/result.json', JSON.stringify({ logs, media: media.map(m => ({ url: m.url.slice(0, 100), len: m.text?.length, ad: /stitched|X-TV-TWITCH-AD-URL/i.test(m.text || '') })) }, null, 2));
console.log('done; logs=', logs.length, 'media=', media.length);
cdp.ws.close(); process.exit(0);
