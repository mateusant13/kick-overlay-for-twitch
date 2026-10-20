#!/usr/bin/env node
// ko-guest.mjs — isolated guest Chrome for Kick Overlay development.
// Loads the unpacked extension through the CDP Extensions domain (Chrome 137+
// ignores --load-extension). Keeps the pipe open; exposes a normal CDP port
// so other tools can attach. Never touches the user's C:\ChromeDebugProfile.
//
// Usage: node ko-guest.mjs start [url]
//        node ko-guest.mjs stop
//        node ko-guest.mjs status
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';

const CHROME = process.env.KO_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const UDD = process.env.KO_GUEST_UDD || 'G:/Temp/ko-guest';
const EXT = process.env.KO_EXT_DIR || 'I:/kicktwitchyoutube_instagram/kick-overlay';
const PORT = process.env.KO_GUEST_PORT || '9333';
const URL_ = process.argv[3] || process.env.KO_GUEST_URL || 'about:blank';
const HEADLESS = process.env.KO_HEADLESS !== '0';
const LOG = 'G:/Temp/opencode/ko-guest.log';

mkdirSync('G:/Temp/opencode', { recursive: true });
function log(...a) {
  const s = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { appendFileSync(LOG, s); } catch {}
  console.log(s.trimEnd());
}

function killTree() {
  // Match both profile families: ko-guest* (manual guest) and ko-harness-*
  // (fresh profiles created by the diagnostic harness). Leaving an old harness
  // Chrome alive kept port 9333 and served STALE extension files, which made
  // fresh-profile tests silently exercise the previous build.
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | ' +
    "Where-Object { $_.CommandLine -like '*ko-guest*' -or $_.CommandLine -like '*ko-harness*' } | " +
    'ForEach-Object { taskkill /PID $($_.ProcessId) /T /F 2>&1 | Out-Null }';
  try { spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' }); } catch {}
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(`${UDD}/${f}`, { force: true }); } catch {}
  }
}

if (process.argv[2] === 'stop') {
  killTree();
  log('stopped');
  process.exit(0);
}

if (process.argv[2] === 'status') {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    console.log(JSON.stringify({ up: true, browser: j.Browser, targets: list.map(t => ({ type: t.type, url: (t.url || '').slice(0, 100), id: t.id })) }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ up: false, error: String(e) }));
  }
  process.exit(0);
}

// start
killTree();
const args = [
  `--user-data-dir=${UDD}`,
  `--remote-debugging-port=${PORT}`,
  '--remote-debugging-pipe',
  '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-extension-debugging',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  ...(HEADLESS ? ['--headless=new', '--disable-gpu'] : ['--window-position=-32000,-32000', '--window-size=1366,900']),
  URL_,
];
log('chrome args', args.join(' '));
const child = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
child.stdio[2].on('data', (d) => { const s = String(d).trim(); if (s && !/TensorFlow|XNNPACK|Fontconfig/.test(s)) log('stderr', s.split('\n').slice(0, 3).join(' | ')); });
child.on('exit', (c) => { log('chrome exited', c); process.exit(0); });

const toChrome = child.stdio[3];
const fromChrome = child.stdio[4];
let buf = Buffer.alloc(0);
const pending = new Map();
const ctxSink = new Set();
fromChrome.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  let i;
  while ((i = buf.indexOf(0)) >= 0) {
    const raw = buf.subarray(0, i).toString('utf8');
    buf = buf.subarray(i + 1);
    let m; try { m = JSON.parse(raw); } catch { continue; }
    if (m.method === 'Runtime.executionContextCreated' && m.params?.context?.origin) ctxSink.add(m.params.context.origin);
    if (m.id !== undefined && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); }
  }
});
let msgSeq = 0;
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const i = ++msgSeq;
  pending.set(i, res);
  toChrome.write(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }) + '\0');
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ __timeout: true, method }); } }, 20000);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(3000);
const lu = await send('Extensions.loadUnpacked', { path: EXT.replaceAll('/', '\\') });
log('loadUnpacked', JSON.stringify(lu).slice(0, 300));
const extId = lu.result?.id || null;
if (!extId) { log('FATAL: extension did not load'); process.exit(2); }

const tg = await send('Target.getTargets', {});
const pages = (tg.result?.targetInfos || []).filter((t) => t.type === 'page');
log('pages', JSON.stringify(pages.map(p => (p.url || '').slice(0, 100))));
if (pages.length) {
  const at = await send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true });
  const sess = at.result?.sessionId;
  if (sess) {
    await send('Page.enable', {}, sess);
    await send('Runtime.enable', {}, sess);
    ctxSink.clear();
    log('reload page for content scripts');
    await send('Page.navigate', { url: URL_ }, sess);
    await sleep(8000);
    const origins = [...ctxSink];
    log('worlds', JSON.stringify(origins));
    log('EXT INJECTED', origins.some(o => o.startsWith('chrome-extension://')));
  }
}
log('READY extId=' + extId + ' port=' + PORT);
await new Promise(() => {});
