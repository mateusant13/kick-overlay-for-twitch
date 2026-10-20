// Capture Twitch player HLS traffic + worker targets on the guest Chrome (9333).
import { writeFileSync, mkdirSync } from 'node:fs';
const PORT = process.env.KO_GUEST_PORT || '9333';
const URL_ = process.argv[2] || 'https://www.twitch.tv/rodil';
const OUT = 'G:/Temp/opencode/tw-net';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
const sessions = new Map([[sessionId, { type: 'page', url: '' }]]);
const reqs = new Map();
const hls = [];

cdp.on('Target.attachedToTarget', async (p, parentSess) => {
  const s = p.sessionId;
  sessions.set(s, { type: p.targetInfo.type, url: p.targetInfo.url });
  console.log('ATTACHED', p.targetInfo.type, p.targetInfo.url.slice(0, 120));
  try {
    await cdp.send('Network.enable', {}, s);
    await cdp.send('Runtime.enable', {}, s);
    if (p.targetInfo.type === 'worker') {
      // worker already started; fetch URLs may still flow once network enabled
    }
  } catch (e) { console.log('attach enable err', e.message); }
});
await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
await cdp.send('Network.enable', {}, sessionId);
await cdp.send('RunTime.enable', {}, sessionId).catch(() => {});
await cdp.send('Page.enable', {}, sessionId);

cdp.on('Network.requestWillBeSent', (p, s) => {
  const u = p.request.url;
  if (/m3u8|usher|gql|playback|ttvnw|video-weaver|cloudfront/i.test(u)) {
    reqs.set(p.requestId, { url: u, sid: s, type: p.type });
    console.log('REQ', p.type, u.slice(0, 240));
  }
});
cdp.on('Network.responseReceived', (p, s) => {
  const r = reqs.get(p.requestId);
  if (r) {
    r.status = p.response.status;
    r.mime = p.response.mimeType;
    r.headers = p.response.headers;
    console.log('RES', p.response.status, p.response.mimeType, r.url.slice(0, 180));
  }
});
cdp.on('Network.loadingFinished', async (p, s) => {
  const r = reqs.get(p.requestId);
  if (!r || !/m3u8|usher/i.test(r.url)) return;
  try {
    const b = await cdp.send('Network.getResponseBody', { requestId: p.requestId }, s);
    const text = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
    const name = `hls-${hls.length}.m3u8`;
    writeFileSync(`${OUT}/${name}`, text);
    hls.push({ name, url: r.url, status: r.status });
    console.log('BODY', name, text.length, 'hasStitched', text.includes('stitched'), 'hasDaterange', text.includes('#EXT-X-DATERANGE'), 'hasTwitchInfo', text.includes('#EXT-X-TWITCH-INFO'));
    if (hls.length <= 3) console.log(text.slice(0, 1600));
  } catch (e) { console.log('body err', e.message); }
});

await cdp.send('Page.navigate', { url: URL_ }, sessionId);
await sleep(25000);
writeFileSync(`${OUT}/summary.json`, JSON.stringify({ hls, sessions: [...sessions.values()] }, null, 2));
console.log('sessions', JSON.stringify([...sessions.values()], null, 2));
console.log('hls files', hls.length);
cdp.ws.close();
process.exit(0);
