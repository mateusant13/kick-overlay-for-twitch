#!/usr/bin/env node
// Minimal OMP browser-relay client for the kick-overlay work.
// Usage:
//   node _tools/relay.mjs list [urlRegex]         (only prints matching pages)
//   node _tools/relay.mjs eval <urlRegex> <js>    (attach, evaluate, detach)
//   node _tools/relay.mjs eval-origin <urlRegex> <originRegex> <js>
//   node _tools/relay.mjs create <url>            (background tab)
//   node _tools/relay.mjs close <urlRegex>
//   node _tools/relay.mjs targets                 (counts only; no urls)
const BASE = process.env.KO_RELAY || 'http://127.0.0.1:9224';

const argv = process.argv.slice(2);
const cmd = argv[0];

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.ev = []; }
  static async open(url = 'ws://127.0.0.1:9224/cdp') {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws timeout')), 8000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(t); rej(new Error('ws error')); }, { once: true });
    });
    const c = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined && c.pend.has(m.id)) { const p = c.pend.get(m.id); c.pend.delete(m.id); p.res(m); return; }
      if (m.method) { c.ev.push(m); if (c.ev.length > 5000) c.ev.splice(0, 1000); }
    });
    return c;
  }
  send(method, params = {}, sessionId, ms = 15000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((res) => {
      this.pend.set(id, { res });
      if (ms) setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); res({ __timeout: true }); } }, ms);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const pageTargets = async (c) => {
  const r = await c.send('Target.getTargets');
  return (r.result?.targetInfos || []).filter((t) => t.type === 'page');
};

const pick = (pages, re) => pages.find((p) => new RegExp(re, 'i').test(p.url || ''));

async function attach(c, target) {
  const att = await c.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  if (!att.result?.sessionId) throw new Error('attach failed: ' + JSON.stringify(att.error || att));
  return att.result.sessionId;
}

async function evalIn(c, target, expression, originRe) {
  const sess = await attach(c, target);
  try {
    await c.send('Runtime.enable', {}, sess, 6000);
    if (originRe) {
      let ctx = null;
      const re = new RegExp(originRe, 'i');
      for (let i = 0; i < 50 && ctx === null; i++) {
        const hits = c.ev.filter((m) => m.method === 'Runtime.executionContextCreated').map((m) => m.params.context);
        const hit = hits.find((x) => re.test((x.origin || '') + ' ' + JSON.stringify(x.auxData || {})));
        if (hit) ctx = hit.id; else await new Promise((r) => setTimeout(r, 120));
      }
      if (ctx === null) throw new Error('context not found for ' + originRe);
      const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, contextId: ctx }, sess, 30000);
      return r;
    }
    const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sess, 30000);
    return r;
  } finally {
    try { await c.send('Target.detachFromTarget', { sessionId: sess }, undefined, 4000); } catch {}
  }
}

const out = (r) => {
  if (r?.__timeout) { console.log(JSON.stringify({ ok: false, erro: 'TIMEOUT (main thread blocked)' })); return; }
  if (r?.error) { console.log(JSON.stringify({ ok: false, cdp: r.error }, null, 1)); return; }
  const ex = r?.result?.exceptionDetails;
  if (ex) { console.log(JSON.stringify({ ok: false, excecao: ex.text, detalhe: String(ex.exception?.description || '').slice(0, 2000) }, null, 1)); return; }
  const v = r?.result?.result?.value;
  if (v === undefined) { console.log(JSON.stringify({ ok: true, valor: r?.result?.result }, null, 1)); return; }
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
};

(async () => {
  const c = await Cdp.open();
  try {
    if (cmd === 'list' || cmd === 'targets') {
      const pages = await pageTargets(c);
      if (cmd === 'targets') { console.log(JSON.stringify({ pages: pages.length })); return; }
      const re = argv[1] ? new RegExp(argv[1], 'i') : null;
      const rows = pages.filter((p) => !re || re.test((p.url || '') + ' ' + (p.title || '')))
        .map((p) => ({ id: p.targetId.slice(0, 8), title: (p.title || '').slice(0, 80), url: (p.url || '').slice(0, 140), attached: !!p.attached }));
      console.log(JSON.stringify(rows, null, 1));
      return;
    }
    if (cmd === 'create') {
      const r = await c.send('Target.createTarget', { url: argv[1], background: true }, undefined, 20000);
      console.log(JSON.stringify({ ok: !!r.result?.targetId, targetId: r.result?.targetId, error: r.error }));
      return;
    }
    if (cmd === 'closetarget') {
      const r = await c.send('Target.closeTarget', { targetId: argv[1] });
      console.log(JSON.stringify({ ok: !!r.result?.success, error: r.error }));
      return;
    }
    if (cmd === 'close') {
      const pages = await pageTargets(c);
      const t = pick(pages, argv[1]);
      if (!t) { console.log(JSON.stringify({ ok: false, erro: 'no match' })); return; }
      const r = await c.send('Target.closeTarget', { targetId: t.targetId });
      console.log(JSON.stringify({ ok: !!r.result?.success, error: r.error }));
      return;
    }
    if (cmd === 'eval' || cmd === 'eval-origin') {
      const originRe = cmd === 'eval-origin' ? argv[2] : null;
      const expr = cmd === 'eval-origin' ? argv[3] : argv[2];
      const pages = await pageTargets(c);
      const t = pick(pages, argv[1]);
      if (!t) { console.log(JSON.stringify({ ok: false, erro: 'no tab matches ' + argv[1] })); return; }
      out(await evalIn(c, t, expr, originRe));
      return;
    }
    if (cmd === 'console') {
      const pages = await pageTargets(c);
      const t = pick(pages, argv[1]);
      if (!t) { console.log(JSON.stringify({ ok: false, erro: 'no tab' })); return; }
      const sess = await attach(c, t);
      await c.send('Runtime.enable', {}, sess, 6000);
      await new Promise((r) => setTimeout(r, Number(argv[2] || 1500)));
      const msgs = c.ev.filter((m) => m.method === 'Runtime.consoleAPICalled').map((m) => ({
        type: m.params.type,
        args: (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 400),
      }));
      console.log(JSON.stringify(msgs.slice(-60), null, 1));
      await c.send('Target.detachFromTarget', { sessionId: sess }, undefined, 4000);
      return;
    }
    console.log('uso: list|targets|eval|eval-origin|create|close|console');
    process.exitCode = 2;
  } finally { c.close(); setTimeout(() => process.exit(), 100); }
})().catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
