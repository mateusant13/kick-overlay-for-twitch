#!/usr/bin/env node
// Reachability attempt for KO-20261023-01 (cold cover) in real Chrome.
//
// What this asks: on a real Twitch page with the shipped extension, does the
// cold-cover branch actually run when an ad-hold arrives while the standby clean
// player is not playing? The candidate answer is recorded as an artifact, and the
// ledger may claim `arm-verified` only when this instrument reports NO-VERDICT:
// the weaker state has to be backed by a failed reachability attempt, not chosen
// because it is convenient.
//
// Outcome vocabulary:
//   RESULT PASS        cover on the hold tick, native hidden, resolved in bound
//   RESULT NO-VERDICT  the branch was not reached (no frame, warm standby, ...)
//   RESULT FAIL        the branch ran and the contract was violated
//
// Requires the guest Chrome harness: node _tools/ko-harness.mjs start <twitch URL> --fresh
// Usage: node _tools/ko-real-arm-d1.mjs [port] [channel]
import { connect, findTargets, attach, delay } from './ko-cdp.mjs';

const port = Number(process.argv[2] || 9333);
const channel = process.argv[3] || '';

const PROBE = `(()=>{
  const f=document.getElementById('ko-adfix');
  const vids=[...document.querySelectorAll('video')];
  return {
    at: Math.round(performance.now()),
    frame: f ? { opacity: f.style.opacity, display: f.style.display } : null,
    native: vids.map(v=>({vis:v.style.visibility, muted:v.muted, paused:v.paused, ct:+Number(v.currentTime||0).toFixed(2)})),
    last: (window.__koTwitchAdblockStats && window.__koTwitchAdblockStats.lastAdLog) || null,
    logs: (window.__koTwitchAdblockStats && window.__koTwitchAdblockStats.adLogCount) || 0,
  };
})()`;

const out = { instrument: 'ko-real-arm-d1', port, channel: channel || null, reached: false, reason: null };

function finish(verdict, detail) {
  out.verdict = verdict;
  if (detail) out.reason = detail;
  console.log(JSON.stringify(out, null, 2));
  console.log(`RESULT ${verdict} d1-reachability${detail ? ` (${detail})` : ''}`);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

const cdp = await connect(port);

// The overlay iframe is recreated on navigation, so re-resolve the target and
// retry rather than trusting one snapshot.
async function attachFresh(kind, tries = 5) {
  let lastErr = new Error(`no ${kind} target`);
  for (let k = 0; k < tries; k++) {
    const t = await findTargets(cdp);
    const target = kind === 'page' ? t.page : t.hls;
    if (target) {
      try {
        return { target, session: await attach(cdp, target, kind) };
      } catch (e) {
        lastErr = e;
      }
    }
    await delay(1000);
  }
  throw lastErr;
}

const { session: s } = await attachFresh('page');
await s.refreshContexts();

// twitch-adblock.js is a `world: "MAIN"` content script, so its globals live in the
// page's default context. Reading the isolated content-script world is what made the
// first attempt report pageId null while the DOM clearly showed #ko-adfix.
const ctx = (s.contexts || []).find(
  (c) => c.auxData && c.auxData.isDefault && String(c.origin || '').startsWith('https://www.twitch.tv'),
);
if (!ctx) finish('NO-VERDICT', 'no twitch.tv main-world context');
const evalPage = (expr) => s.evalRaw(expr, { contextId: ctx.id });

const info = await evalPage(
  `({href:location.href,pageId:(window.__koTwitchAdblockStats||{}).pageId||null,attr:document.documentElement.getAttribute('data-ko-adblock'),frame:!!document.getElementById('ko-adfix')})`,
);
out.href = info.href;
out.pageId = info.pageId;
out.frame_present = info.frame;
if (!info.pageId) finish('NO-VERDICT', 'adblock module exposed no pageId: cannot post a page-scoped hold');
if (!info.frame) finish('NO-VERDICT', 'no #ko-adfix frame: the cold-cover branch is unreachable on this page');

out.before_hold = await evalPage(PROBE);

// If the standby is already playing, this run can only exercise the warm path, which
// reveals immediately and never sets cold-cover. Say so instead of scoring it.
out.hold_posted = await evalPage(`(()=>{
  const c=new BroadcastChannel('ko-adblock-bypass');
  c.postMessage({ type:'ad-hold', page:${JSON.stringify(info.pageId)}, channel:${JSON.stringify(channel || null)} });
  c.close(); return true;
})()`);

const fast = [];
for (let k = 0; k < 25; k++) {
  await delay(100);
  fast.push(await evalPage(PROBE));
}
const events = [...new Set(fast.map((x) => (x.last ? x.last.ev : null)).filter(Boolean))];
const cover = fast.find((x) => x.last && x.last.ev === 'cold-cover');
out.cover = {
  events,
  cold_cover_at_ms: cover ? cover.at : null,
  frame_opaque_at_ms: (fast.find((x) => x.frame && x.frame.opacity === '1') || {}).at ?? null,
  native_hidden_when_covered: cover ? cover.native.length > 0 && cover.native.every((v) => v.vis === 'hidden') : null,
};

if (!cover) {
  const warm = events.some((e) => /overlay-reveal|reveal-muted/.test(String(e)));
  finish('NO-VERDICT', warm ? 'warm standby path taken (reveal), cold-cover not entered' : 'cold-cover never logged');
}

const tail = [];
for (let k = 0; k < 28; k++) {
  await delay(500);
  const p = await evalPage(PROBE);
  tail.push({ at_ms: 2500 + (k + 1) * 500, ev: p.last ? p.last.ev : null, opacity: p.frame ? p.frame.opacity : null, nativeVis: p.native.map((v) => v.vis) });
  if (p.last && /cold-cover-timeout|overlay-stop|overlay-reveal/.test(String(p.last.ev))) break;
}
out.tail = tail;
const resolved = tail.find((t) => /cold-cover-timeout|overlay-stop|overlay-reveal/.test(String(t.ev)));
out.resolution = resolved || null;

const coveredOK = out.cover.frame_opaque_at_ms !== null && out.cover.native_hidden_when_covered === true;
const boundOK = !!resolved && resolved.at_ms <= 14000;
if (!coveredOK) finish('FAIL', 'cold-cover logged without the frame opaque or the native hidden');
if (!boundOK) finish('FAIL', 'no reveal/timeout inside the 12 s bound');
finish('PASS', `cover at ${out.cover.cold_cover_at_ms} ms, resolved at ${resolved.at_ms} ms (${resolved.ev})`);
