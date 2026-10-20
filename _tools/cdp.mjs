#!/usr/bin/env node
// Client for the persistent CDP daemon (cdp-daemon.mjs).
// The daemon opens ONE Chrome WebSocket, so chrome://inspect asks for
// approval only once. All commands below reuse it.
//
// Usage:
//   node _tools/cdp.mjs list [urlRegex]
//   node _tools/cdp.mjs contexts <urlRegex>
//   node _tools/cdp.mjs eval <urlRegex> <js> [originRegex]
//   node _tools/cdp.mjs console <urlRegex> [ms]
//   node _tools/cdp.mjs bgcreate <url>
//   node _tools/cdp.mjs close <targetId>
//   node _tools/cdp.mjs stop
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STATE_FILE = process.env.KO_DAEMON_FILE || 'G:/Temp/opencode/ko-cdp-daemon.json';
const DAEMON = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'cdp-daemon.mjs');
const [cmd, ...argv] = process.argv.slice(2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function rpc(state, msg, ms = 60000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(state.port, '127.0.0.1');
    let buf = '';
    const t = setTimeout(() => { sock.destroy(); reject(new Error('daemon timeout')); }, ms);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ ...msg, token: state.token }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(t);
      try { sock.end(); resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function ensureDaemon() {
  let st = readState();
  if (st) {
    try { const p = await rpc(st, { op: 'ping' }, 2500); if (p.ok) return st; } catch {}
    try { fs.unlinkSync(STATE_FILE); } catch {}
  }
  // Spawn detached and hidden; it survives this command.
  const child = spawn(process.execPath, [DAEMON], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: process.env,
  });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    st = readState();
    if (st) {
      try { const p = await rpc(st, { op: 'ping' }, 3000); if (p.ok) return st; } catch {}
    }
    await sleep(250);
  }
  throw new Error('daemon did not start. Chrome may be waiting for the remote-debugging approval dialog ("Allow") — approve it once.');
}

const t = await (async () => {
  const st = await ensureDaemon();
  if (cmd === 'stop') {
    try { await rpc(st, { op: 'ping' }, 2000); } catch {}
    try { process.kill(st.pid); } catch {}
    try { fs.unlinkSync(STATE_FILE); } catch {}
    return { stopped: st.pid };
  }
  if (cmd === 'list') {
    return (await rpc(st, { op: 'list', match: argv[0] || '' })).result;
  }
  if (cmd === 'bgcreate') {
    return (await rpc(st, { op: 'create', url: argv[0] })).result;
  }
  if (cmd === 'close') {
    return (await rpc(st, { op: 'close', targetId: argv[0] })).result;
  }
  const list = (await rpc(st, { op: 'list', match: argv[0] || '' })).result || [];
  if (cmd === 'contexts') {
    const target = list[0];
    if (!target) throw new Error('no tab matches ' + (argv[0] || ''));
    return (await rpc(st, { op: 'contexts', targetId: target.targetId })).result;
  }
  if (cmd === 'eval' || cmd === 'console') {
    const target = list[0];
    if (!target) throw new Error('no tab matches ' + (argv[0] || ''));
    if (cmd === 'eval') {
      const r = await rpc(st, { op: 'eval', targetId: target.targetId, expression: argv[1], originRe: argv[2] || null });
      return r.result?.value ?? r.result;
    }
    const ms = Number(argv[1] || 1500);
    return (await rpc(st, { op: 'console', targetId: target.targetId, ms })).result;
  }
  throw new Error('uso: list|contexts|eval|console|bgcreate|close|stop');
})();

console.log(typeof t === 'string' ? t : JSON.stringify(t, null, 1));
process.exit(0);
