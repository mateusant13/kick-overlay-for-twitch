// Reload the YT HLS layer and capture googlevideo request statuses/errors.
const PORT = '9333';
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
  async send(method, params = {}, sessionId, timeout = 30000) {
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
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find(t => t.type === 'page' && /twitch\.tv\/rodil/.test(t.url));
const yt = targets.find(t => t.type === 'iframe' && /player\.html\?m=hls/.test(t.url));
if (!page || !yt) { console.log('missing targets', targets.map(t => [t.type, t.url])); process.exit(1); }
const ps = (await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })).sessionId;
const ys = (await cdp.send('Target.attachToTarget', { targetId: yt.id, flatten: true })).sessionId;
const reqs = new Map();
cdp.on('Network.requestWillBeSent', (p, s) => {
  if (s === ys && /googlevideo|manifest/.test(p.request.url)) {
    reqs.set(p.requestId, p.request.url);
    console.log('REQ', p.request.url.slice(0, 160));
  }
});
cdp.on('Network.responseReceived', (p, s) => {
  if (s === ys && /googlevideo|manifest/.test(p.response.url)) {
    console.log('RES', p.response.status, p.response.mimeType, p.response.url.slice(0, 140));
  }
});
cdp.on('Network.loadingFailed', (p, s) => {
  if (s === ys) console.log('FAIL', p.errorText, p.blockedReason || '', p.requestId);
});
cdp.on('Runtime.consoleAPICalled', (p, s) => {
  if (s === ys) console.log('CONSOLE', p.type, p.args.map(a => a.value ?? a.description).join(' ').slice(0, 300));
});
cdp.on('Runtime.exceptionThrown', (p, s) => {
  if (s === ys) console.log('EXC', JSON.stringify(p.exceptionDetails).slice(0, 400));
});
const pctx = [];
cdp.on('Runtime.executionContextCreated', (p, s) => { if (s === ps) pctx.push(p.context); });
await cdp.send('Network.enable', {}, ys);
await cdp.send('Runtime.enable', {}, ys);
await cdp.send('Runtime.enable', {}, ps);
await sleep(400);
const isolated = pctx.find(c => (c.origin || '').startsWith('chrome-extension://') && c.auxData?.type === 'isolated');
if (!isolated) { console.log('no isolated ctx', pctx.map(c => [c.origin, c.auxData])); process.exit(2); }
// Ask the content script to reload the same URL through the normal bridge.
const ev = await cdp.send('Runtime.evaluate', {
  expression: 'new Promise(res=>{const u=KO.ytHlsUrl; ytCmd({t:"load",url:u}); setTimeout(()=>res(u),300);})',
  awaitPromise: true, returnByValue: true, contextId: isolated.id,
}, ps);
console.log('URL', String(ev.result?.value).slice(0, 120));
await sleep(15000);
const st = await cdp.send('Runtime.evaluate', {
  expression: '({ct:KO.ytState.ct,lat:KO.ytState.lat,playing:KO.ytState.playing,live:KO.ytState.live,fail:KO.ytHlsFailed,err:KO.ytState.error})',
  returnByValue: true, contextId: isolated.id,
}, ps);
console.log('STATE', JSON.stringify(st.result?.value));
cdp.ws.close(); process.exit(0);
