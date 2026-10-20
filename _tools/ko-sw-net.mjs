// Attach to KO's service worker and inspect the YouTube player fetch headers.
const PORT = process.env.KO_GUEST_PORT || '9333';
const EXT = 'lidnecmhfmcaimlfecmejmnohdcbjkfp';
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
      } else if (m.method && this.handlers.has(m.method)) for (const cb of this.handlers.get(m.method)) cb(m.params, m.sessionId);
    };
  }
  async send(method, params = {}, sessionId, timeout = 60000) {
    await this.ready; const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ': timeout')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  on(m, cb) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(cb); }
}
const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const cdp = new CDP(v.webSocketDebuggerUrl);
const targets = await cdp.send('Target.getTargets');
const sw = targets.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(EXT));
if (!sw) { console.log('no SW target', targets.targetInfos.map(t => [t.type, t.url])); process.exit(1); }
console.log('SW', sw.url);
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
cdp.on('Network.requestWillBeSent', (p) => {
  if (/youtube|googlevideo/.test(p.request.url)) console.log('REQ', p.request.method, p.request.url.slice(0, 140), 'headers', JSON.stringify(p.request.headers));
});
cdp.on('Network.requestWillBeSentExtraInfo', (p) => {
  console.log('EXTRA', JSON.stringify(p.headers).slice(0, 800));
});
cdp.on('Network.responseReceived', (p) => {
  if (/youtube|googlevideo/.test(p.response.url)) console.log('RES', p.response.status, p.response.mimeType, p.response.url.slice(0, 120), 'loc', p.response.headers.location || '');
});
await cdp.send('Network.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
const expr = `(async()=>{try{const u=await koMintManifest('3cOk_W3ewcE');return {ok:u.slice(0,80)}}catch(e){return {err:String(e).slice(0,300)}}})()`;
const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
console.log('RESULT', JSON.stringify(r.result?.value || r, null, 2));
await sleep(2000);
cdp.ws.close(); process.exit(0);
