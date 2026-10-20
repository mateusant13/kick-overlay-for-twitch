#!/usr/bin/env node
// Persistent CDP daemon for the owner's Chrome (chrome://inspect remote debugging).
//
// WHY: with chrome://inspect/#remote-debugging, Chrome asks for approval on
// EVERY new CDP WebSocket connection (no "always allow" exists yet). This
// daemon opens ONE WebSocket, keeps it alive, and serves all later commands
// over a local TCP socket. Approve once; reuse indefinitely.
//
// State file (port + token + pid): G:\Temp\opencode\ko-cdp-daemon.json
// Protocol: newline-delimited JSON requests/responses on 127.0.0.1:<port>.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT_FILE = process.env.KO_PORT_FILE ||
  'C:/Users/Administrador/AppData/Local/Google/Chrome/User Data/DevToolsActivePort';
const STATE_FILE = process.env.KO_DAEMON_FILE ||
  'G:/Temp/opencode/ko-cdp-daemon.json';
const HOST = '127.0.0.1';

function log(...a) {
  try { fs.appendFileSync('G:/Temp/opencode/ko-cdp-daemon.log', new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch {}
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.ev = []; this.contexts = new Map(); }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws timeout')), 15000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws error')); }, { once: true });
    });
    const c = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.method === 'Runtime.executionContextCreated' && m.sessionId) {
        const ctx = m.params.context;
        if (!c.contexts.has(m.sessionId)) c.contexts.set(m.sessionId, new Map());
        c.contexts.get(m.sessionId).set(ctx.id, ctx);
      }
      if (m.method === 'Runtime.executionContextDestroyed' && m.sessionId) {
        c.contexts.get(m.sessionId)?.delete(m.params.executionContextId);
      }
      if (m.method === 'Runtime.executionContextsCleared' && m.sessionId) {
        c.contexts.get(m.sessionId)?.clear();
      }
      if (m.method === 'Target.detachedFromTarget' && m.params?.sessionId) {
        c.contexts.delete(m.params.sessionId);
      }
      if (m.id !== undefined && c.pend.has(m.id)) {
        const p = c.pend.get(m.id); c.pend.delete(m.id); p.res(m); return;
      }
      if (m.method) { c.ev.push(m); if (c.ev.length > 12000) c.ev.splice(0, 4000); }
    });
    return c;
  }
  send(method, params = {}, sessionId, ms = 30000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((res) => {
      this.pend.set(id, { res });
      if (ms) setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); res({ __timeout: true }); } }, ms);
    });
  }
}

const raw = fs.readFileSync(PORT_FILE, 'utf8').trim().split(/\r?\n/);
const wsUrl = `ws://127.0.0.1:${raw[0]}${raw[1]}`;
const c = await Cdp.open(wsUrl);
log('connected', wsUrl);

const sessions = new Map(); // targetId -> sessionId
const targetBySession = new Map();

async function attach(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const a = await c.send('Target.attachToTarget', { targetId, flatten: true });
  if (!a.result?.sessionId) throw new Error('attach: ' + JSON.stringify(a.error || a));
  sessions.set(targetId, a.result.sessionId);
  targetBySession.set(a.result.sessionId, targetId);
  // Prime Runtime so execution-context events are delivered from now on.
  await c.send('Runtime.enable', {}, a.result.sessionId, 10000);
  return a.result.sessionId;
}

async function pages() {
  const r = await c.send('Target.getTargets');
  return (r.result?.targetInfos || []).filter((t) => t.type === 'page');
}

function waitContexts(sessionId, originRe, ms = 4000) {
  const re = originRe ? new RegExp(originRe, 'i') : null;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const map = c.contexts.get(sessionId) || new Map();
      const all = [...map.values()];
      if (re) {
        const hit = all.find((x) => re.test((x.origin || '') + ' ' + JSON.stringify(x.auxData || {})));
        if (hit) return resolve(hit);
      } else if (all.length) {
        return resolve(all.find((x) => x.auxData?.isDefault) || all[0]);
      }
      if (Date.now() - t0 > ms) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function handle(req) {
  const op = req.op;
  if (op === 'ping') return { pong: true, pid: process.pid };
  if (op === 'list') {
    const list = await pages();
    const re = req.match ? new RegExp(req.match, 'i') : null;
    return list
      .filter((p) => !re || re.test((p.url || '') + ' ' + (p.title || '')))
      .map((p) => ({ targetId: p.targetId, title: p.title, url: p.url, attached: !!p.attached }));
  }
  if (op === 'create') {
    const r = await c.send('Target.createTarget', { url: req.url, background: req.background !== false, newWindow: false });
    if (!r.result?.targetId) throw new Error('create: ' + JSON.stringify(r.error || r));
    return { targetId: r.result.targetId };
  }
  if (op === 'close') {
    const r = await c.send('Target.closeTarget', { targetId: req.targetId });
    sessions.delete(req.targetId);
    return { ok: !!r.result?.success };
  }
  if (op === 'detach') {
    const s = sessions.get(req.targetId);
    if (s) { try { await c.send('Target.detachFromTarget', { sessionId: s }, undefined, 5000); } catch {} sessions.delete(req.targetId); targetBySession.delete(s); }
    return { ok: true };
  }
  if (op === 'contexts') {
    const s = await attach(req.targetId);
    const map = c.contexts.get(s) || new Map();
    let all = [...map.values()];
    if (!all.length) { const hit = await waitContexts(s, null, 2500); all = hit ? [hit] : []; }
    return all.map((x) => ({ id: x.id, origin: x.origin, name: x.name, world: x.auxData?.type + ':' + (x.auxData?.isDefault ? 'default' : 'isolated') }));
  }
  if (op === 'eval') {
    const s = await attach(req.targetId);
    let ctxId;
    if (req.originRe) {
      const hit = await waitContexts(s, req.originRe, 5000);
      if (!hit) throw new Error('context not found: ' + req.originRe);
      ctxId = hit.id;
    }
    const r = await c.send('Runtime.evaluate', {
      expression: req.expression, returnByValue: true, awaitPromise: true, userGesture: true,
      ...(ctxId ? { contextId: ctxId } : {}),
    }, s, 45000);
    if (r.__timeout) throw new Error('evaluate timeout');
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(ex.text + ' :: ' + String(ex.exception?.description || '').slice(0, 1500));
    return { value: r.result?.result?.value, type: r.result?.result?.type };
  }
  if (op === 'console') {
    const s = await attach(req.targetId);
    await c.send('Runtime.enable', {}, s, 8000);
    const start = c.ev.length;
    await new Promise((r) => setTimeout(r, Math.max(200, Math.min(15000, req.ms || 1500))));
    return c.ev.slice(start)
      .filter((m) => m.method === 'Runtime.consoleAPICalled')
      .map((m) => ({
        type: m.params.type,
        args: (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 400),
      }));
  }
  throw new Error('unknown op: ' + op);
}

const token = crypto.randomBytes(16).toString('hex');
const server = net.createServer((sock) => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', async (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let req; try { req = JSON.parse(line); } catch { continue; }
      if (req.token !== token) { sock.write(JSON.stringify({ id: req.id, ok: false, error: 'bad token' }) + '\n'); continue; }
      try {
        const result = await handle(req);
        sock.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
      } catch (e) {
        sock.write(JSON.stringify({ id: req.id, ok: false, error: String(e?.message || e) }) + '\n');
      }
    }
  });
  sock.on('error', () => {});
});

server.listen(0, HOST, () => {
  const port = server.address().port;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ port, token, pid: process.pid, wsUrl, at: Date.now() }));
  log('listening', port, 'pid', process.pid);
});

c.ws.addEventListener('close', () => {
  log('chrome ws closed; exiting');
  try { fs.unlinkSync(STATE_FILE); } catch {}
  process.exit(0);
});

process.on('SIGTERM', () => { try { fs.unlinkSync(STATE_FILE); } catch {} process.exit(0); });
process.on('SIGINT', () => { try { fs.unlinkSync(STATE_FILE); } catch {} process.exit(0); });
