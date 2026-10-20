#!/usr/bin/env node
// ko-harness.mjs — one diagnostic harness for the Kick Overlay extension.
// (The check suite lives in ko-harness-check.mjs; the CDP client in ko-cdp.mjs.)
//
//   node _tools/ko-harness.mjs start [url] [--fresh]
//   node _tools/ko-harness.mjs check [--yt=<watch/live URL>] [--no-adblock]
//   node _tools/ko-harness.mjs state
//   node _tools/ko-harness.mjs set --player=youtube --yt=https://...
//   node _tools/ko-harness.mjs eval "KO.kickState" --world=isolated
//   node _tools/ko-harness.mjs click "#ko-golive" --real
//   node _tools/ko-harness.mjs shot [path]
//   node _tools/ko-harness.mjs net --pattern=googlevideo --seconds=10 --target=hls
//   node _tools/ko-harness.mjs console --seconds=5
//   node _tools/ko-harness.mjs stop
//
// Exit 0 = PASS/SKIP/WARN only; 1 = FAIL or exception.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { connect, findTargets, attach } from './ko-cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUEST = path.join(HERE, 'ko-guest.mjs');
const PORT = Number(process.env.KO_PORT || 9333);
const OUT_DIR = 'G:/Temp/opencode';
const DEFAULT_URL = process.env.KO_GUEST_URL || 'https://www.twitch.tv/rodil';
const DEFAULT_YT = 'https://www.youtube.com/watch?v=3cOk_W3ewcE';
mkdirSync(OUT_DIR, { recursive: true });

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // Split on the FIRST '=' only: URLs/queries contain '=' (watch?v=...).
      const body = a.slice(2);
      const eq = body.indexOf('=');
      const k = eq === -1 ? body : body.slice(0, eq);
      const v = eq === -1 ? undefined : body.slice(eq + 1);
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

async function guestUp(timeout = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(timeout) });
    return r.ok;
  } catch { return false; }
}

function stopGuest() {
  const r = spawnSync(process.execPath, [GUEST, 'stop'], { encoding: 'utf8' });
  process.stdout.write((r.stdout || '').trim() + '\n');
}

async function ensureGuest({ fresh = false, url = DEFAULT_URL, quiet = false } = {}) {
  if (await guestUp()) {
    if (!fresh) return;
    stopGuest();
    await delay(1200);
  }
  const udd = fresh
    ? `G:/Temp/ko-harness-${new Date().toISOString().replace(/[:.]/g, '-')}`
    : (process.env.KO_GUEST_UDD || 'G:/Temp/ko-harness-profile');
  if (!quiet) console.log(`[harness] starting guest Chrome profile=${udd}`);
  const child = spawn(process.execPath, [GUEST, 'start', url], {
    env: { ...process.env, KO_GUEST_UDD: udd, KO_GUEST_PORT: String(PORT) },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 45000) {
    if (await guestUp()) return;
    await delay(1000);
  }
  throw new Error('guest Chrome did not open the CDP port');
}

async function openSessions({ requireKo = true } = {}) {
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < 45000) {
    try {
      const cdp = await connect(PORT);
      const t = await findTargets(cdp, { pageRe: /twitch\.tv|youtube\.com/ });
      if (!t.page) throw new Error('no Twitch/YouTube page target');
      const page = await attach(cdp, t.page, 'page');
      page.cdp = cdp;
      await page.enable({ page: true });
      // The content script may still be loading after the guest's reload.
      let ko = false;
      try { ko = await page.evalIsolated('typeof KO !== "undefined" && !!KO'); } catch { /* no isolated ctx yet */ }
      if (requireKo && !ko) throw new Error('content script not injected yet');
      const sw = await attach(cdp, t.sw, 'sw');
      const hls = await attach(cdp, t.hls, 'hls');
      const ivs = await attach(cdp, t.ivs, 'ivs');
      if (hls) await hls.enable({ network: true });
      if (ivs) await ivs.enable();
      if (sw) await sw.enable();
      return { cdp, targets: t, page, sw, hls, ivs };
    } catch (e) {
      lastErr = e;
      await delay(1000);
    }
  }
  throw new Error(`openSessions: ${lastErr?.message || 'timeout'}`);
}

async function refreshIframes(s) {
  const t = await findTargets(s.cdp, { pageRe: /twitch\.tv|youtube\.com/ });
  if (t.hls && (!s.hls || s.hls.targetId !== t.hls.targetId)) {
    s.hls = await attach(s.cdp, t.hls, 'hls');
    await s.hls.enable({ network: true });
  }
  if (t.ivs && (!s.ivs || s.ivs.targetId !== t.ivs.targetId)) {
    s.ivs = await attach(s.cdp, t.ivs, 'ivs');
    await s.ivs.enable();
  }
  return s;
}

const STATE_EXPR = `(() => {
  const out = { href: location.href, readyState: document.readyState };
  if (typeof KO !== 'undefined' && KO) {
    const pill = document.getElementById('ko-golive');
    out.ko = {
      enabled: KO.enabled, player: KO.player, playerPreference: KO.playerPreference,
      slug: KO.slug, kickSlug: KO.kickSlug, ytRaw: KO.ytRaw, ytId: KO.ytId,
      ytHls: String(KO.ytHlsUrl || '').slice(0, 100), ytHlsFailed: KO.ytHlsFailed,
      kickReady: KO.kickReady, kickState: KO.kickState, kickOnDvr: KO.kickOnDvr,
      kickDur: KO.kickDur, yt: KO.ytState, adblock: KO.adblock,
      wrap: KO.wrap ? { cls: KO.wrap.className, display: KO.wrap.style.display } : null,
      pill: pill ? {
        display: getComputedStyle(pill).display,
        pointerEvents: getComputedStyle(pill).pointerEvents,
        text: pill.textContent,
      } : null,
    };
  }
  const v = document.querySelector('video');
  out.twitchVideo = v ? { paused: v.paused, muted: v.muted, ct: v.currentTime, rs: v.readyState, dur: v.duration } : null;
  return out;
})()`;

const ADBLOCK_EXPR = `({
  stats: window.__koTwitchAdblockStats || null,
  flag: window.__koTwitchAdblock === true,
  attr: document.documentElement.getAttribute('data-ko-adblock'),
  worker: String(window.Worker).slice(0, 60),
})`;

async function getState(s) {
  const page = await s.page.evalIsolated(STATE_EXPR);
  let adblock = null;
  try { adblock = await s.page.evalMain(ADBLOCK_EXPR); } catch { /* main world not ready */ }
  let hlsVideo = null;
  if (s.hls) {
    try {
      hlsVideo = await s.hls.evalRaw(`(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        const s = []; for (let i = 0; i < v.seekable.length; i++) s.push([v.seekable.start(i), v.seekable.end(i)]);
        const b = []; for (let i = 0; i < v.buffered.length; i++) b.push([v.buffered.start(i), v.buffered.end(i)]);
        return { ct: v.currentTime, dur: v.duration, paused: v.paused, rs: v.readyState, ended: v.ended, muted: v.muted, seekable: s, buffered: b };
      })()`);
    } catch { /* frame gone */ }
  }
  return { ...page, adblock, hlsVideo };
}

async function setConfig(s, cfg) {
  const payload = JSON.stringify(cfg);
  const res = await s.page.evalIsolated(`new Promise((res) => {
    chrome.storage.local.get('ko.v2', (o) => {
      const st = o['ko.v2'] || {};
      const cfg = ${payload};
      if (cfg.enabled !== undefined) st.enabled = !!cfg.enabled;
      if (cfg.player) st.player = cfg.player;
      if (cfg.yt) {
        st.mappings = { ...(st.mappings || {}) };
        st.mappings[st.slug || cfg.slug || 'rodil'] = { ...(st.mappings[st.slug || cfg.slug || 'rodil'] || {}), yt: cfg.yt };
      }
      if (cfg.ytId) {
        st.mappings = { ...(st.mappings || {}) };
        st.mappings[st.slug || cfg.slug || 'rodil'] = { ...(st.mappings[st.slug || cfg.slug || 'rodil'] || {}), ytId: cfg.ytId };
      }
      chrome.storage.local.set({ 'ko.v2': st }, () => res(st));
    });
  })`);
  return res;
}

function printState(st) {
  console.log(JSON.stringify(st, null, 2));
}

function usage() {
  console.log(`ko-harness commands:
  start [url] [--fresh]          start guest Chrome (fresh profile optional)
  stop                           stop guest Chrome
  status                         guest up? + targets
  state                          KO + adblock + iframe snapshot
  check [--yt=URL] [--no-adblock] end-to-end PASS/FAIL suite
  set --player=kick|youtube|twitch [--yt=URL] [--enabled=1|0]
  eval "<expr>" [--world=isolated|main] [--target=page|sw|hls|ivs]
  click "<selector>" [--real]    real mouse or synthetic click
  shot [path]                    PNG screenshot
  net --pattern=RE --seconds=N [--target=hls|page|sw]
  console [--seconds=N]          captured errors from page/hls/sw`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { _: pos, flags } = parseArgs(argv);
  const cmd = pos[0] || 'help';

  if (cmd === 'help' || flags.help) { usage(); return; }
  if (cmd === 'start') {
    await ensureGuest({ fresh: !!flags.fresh, url: pos[1] || DEFAULT_URL });
    console.log('[harness] guest up; waiting for content script…');
    const s = await openSessions();
    const st = await getState(s);
    console.log('[harness] ready', JSON.stringify({ href: st.href, ko: !!st.ko, enabled: st.ko?.enabled, player: st.ko?.player }));
    s.cdp.close();
    return;
  }
  if (cmd === 'stop') { stopGuest(); return; }
  if (cmd === 'status') {
    const up = await guestUp();
    console.log(JSON.stringify({ up, port: PORT }, null, 2));
    if (up) {
      const cdp = await connect(PORT);
      const t = await findTargets(cdp, { pageRe: /twitch\.tv|youtube\.com/ });
      console.log(JSON.stringify({
        page: t.page?.url, hls: t.hls?.url?.slice(0, 100), ivs: t.ivs?.url?.slice(0, 100), sw: t.sw?.url,
      }, null, 2));
      cdp.close();
    }
    return;
  }

  // Commands below need a live page + content script. Start the guest if it is
  // not up yet; --fresh always replaces the profile with clean extension code.
  if (!(await guestUp()) || flags.fresh) {
    await ensureGuest({ fresh: !!flags.fresh, url: flags.url || DEFAULT_URL });
  }
  const s = await openSessions();

  if (cmd === 'state') { printState(await getState(s)); s.cdp.close(); return; }

  if (cmd === 'set') {
    const cfg = {
      player: flags.player,
      yt: flags.yt,
      ytId: flags['yt-id'],
      enabled: flags.enabled === undefined ? undefined : String(flags.enabled) !== '0',
      slug: flags.slug,
    };
    const st = await setConfig(s, cfg);
    console.log('[harness] storage', JSON.stringify({ player: st.player, enabled: st.enabled, mappings: st.mappings }));
    if (flags.reload) await s.page.reload();
    console.log('[harness] state', JSON.stringify((await getState(s)).ko));
    s.cdp.close();
    return;
  }

  if (cmd === 'eval') {
    const expr = pos[1];
    if (!expr) throw new Error('eval needs an expression');
    const target = flags.target || 'page';
    const world = flags.world || (target === 'page' ? 'isolated' : 'main');
    let val;
    if (target === 'page') val = world === 'main' ? await s.page.evalMain(expr) : await s.page.evalIsolated(expr);
    else if (target === 'sw') val = await s.sw.evalRaw(expr, { contextId: s.sw.mainContext()?.id });
    else if (target === 'hls') val = await s.hls.evalRaw(expr, { contextId: s.hls.mainContext()?.id });
    else if (target === 'ivs') val = await s.ivs.evalRaw(expr, { contextId: s.ivs.mainContext()?.id });
    else throw new Error(`unknown target ${target}`);
    console.log(JSON.stringify(val, null, 2));
    s.cdp.close();
    return;
  }

  if (cmd === 'click') {
    const selector = pos[1];
    if (!selector) throw new Error('click needs a selector');
    const r = await s.page.click(selector, { real: !flags.synthetic, settle: Number(flags.settle || 800) });
    console.log(JSON.stringify(r, null, 2));
    s.cdp.close();
    return;
  }

  if (cmd === 'shot') {
    const file = pos[1] || path.join(OUT_DIR, `ko-harness-${Date.now()}.png`);
    await s.page.setViewport(Number(flags.width || 1600), Number(flags.height || 900));
    await delay(800);
    await s.page.screenshot(file);
    console.log(file);
    s.cdp.close();
    return;
  }

  if (cmd === 'net') {
    const pattern = new RegExp(flags.pattern || '.', 'i');
    const seconds = Number(flags.seconds || 8);
    const target = flags.target || 'hls';
    const sess = target === 'hls' ? s.hls : target === 'ivs' ? s.ivs : target === 'sw' ? s.sw : s.page;
    if (!sess) throw new Error(`${target} session not attached`);
    await sess.cdp.send('Network.enable', {}, sess.sessionId);
    sess.network = [];
    await delay(seconds * 1000);
    const rows = sess.network.filter((n) => pattern.test(n.url));
    const summary = new Map();
    for (const n of rows.filter((r) => r.kind === 'res')) summary.set(n.status, (summary.get(n.status) || 0) + 1);
    console.log(JSON.stringify({
      target, count: rows.length, statuses: Object.fromEntries(summary),
      rows: rows.slice(-80).map((r) => ({ kind: r.kind, status: r.status, mime: r.mime, error: r.error, url: String(r.url).slice(0, 180) })),
    }, null, 2));
    s.cdp.close();
    return;
  }

  if (cmd === 'console') {
    const seconds = Number(flags.seconds || 5);
    await delay(seconds * 1000);
    console.log(JSON.stringify({
      page: { exceptions: s.page.exceptions, console: s.page.console },
      hls: s.hls ? { exceptions: s.hls.exceptions, console: s.hls.console } : null,
      ivs: s.ivs ? { exceptions: s.ivs.exceptions, console: s.ivs.console } : null,
      sw: s.sw ? { exceptions: s.sw.exceptions, console: s.sw.console } : null,
    }, null, 2));
    s.cdp.close();
    return;
  }

  if (cmd === 'check') {
    const { runCheck } = await import('./ko-harness-check.mjs');
    const yt = flags.yt || DEFAULT_YT;
    const report = await runCheck(s, {
      yt,
      adblock: !flags['no-adblock'],
      viewport: { width: Number(flags.width || 1600), height: Number(flags.height || 900) },
      onRefresh: () => refreshIframes(s),
    });
    s.cdp.close();
    process.exitCode = report.failed ? 1 : 0;
    return;
  }

  throw new Error(`unknown command ${cmd}`);
}

main()
  .then(() => {
    // A detached guest + the browser WebSocket can keep handles alive; this is
    // a CLI, so exit explicitly (the guest is detached and keeps running).
    setTimeout(() => process.exit(process.exitCode || 0), 150);
  })
  .catch((e) => {
    console.error('[harness] ERROR', e?.stack || e?.message || e);
    process.exit(1);
  });
