// Real-browser arm for KO-20261026-04 (the extension must not resume a video the
// user paused himself). Runs in the guest Chrome with the shipped unpacked build,
// on a real Twitch watch page with the native player really playing.
//
//   ARM A (the reported defect): the user pauses via Twitch's own pause button,
//   then 50 s of real time pass, which covers two 20 s probe() ticks. The video
//   must stay paused with currentTime frozen.
//   ARM B (positive control): KO.twWasPlaying is set the way syncMute sets it when
//   the EXTENSION paused, so the same probe path has to resume the video. If arm B
//   did not fire, arm A's green would only prove the probe is dead.
//
// Usage: node G:/Temp/opencode/ko-d2-real-arm.mjs [port]
import { connect, findTargets, attach, delay } from './ko-cdp.mjs';

const port = Number(process.argv[2] || 9333);
const SAMPLES = 10;
const SAMPLE_MS = 5000;

const VIDEO = `(v=>({paused:v.paused,ct:+Number(v.currentTime||0).toFixed(2),rs:v.readyState,muted:v.muted}))(document.querySelector('video'))`;

const cdp = await connect(port);
const { page } = await findTargets(cdp);
if (!page) throw new Error('no page target');
const s = await attach(cdp, page, 'page');

const out = { href: '', armA: {}, armB: {}, pass: false };

const state = async () => s.evalMain(VIDEO);
out.href = await s.evalMain('location.href');
let before = await state();
// Arm A needs a playing video so the later pause is a real user pause. Player
// preference "kick" leaves the native element paused by design, so start it and
// record that this was the instrument, not the user.
if (before.paused) {
  await s.evalMain(`document.querySelector('video').play().catch(()=>null)`);
  for (let k = 0; k < 16; k++) {
    await delay(500);
    before = await state();
    if (!before.paused) break;
  }
  out.precondition = before.paused
    ? `video stayed paused after play() (${JSON.stringify(before)}): run with player=twitch and no KO layer`
    : 'video was paused by the page; the instrument started it before arm A';
  if (before.paused) {
    console.log(JSON.stringify(out, null, 2));
    console.log('RESULT NO-VERDICT d2-reachability (native page player never started)');
    process.exit(1);
  }
}

// Real user pause: the Twitch control bar button, clicked through CDP input.
const BTN = '[data-a-target="player-play-pause-button"]';
let pausePath = 'twitch-pause-button';
await s.evalMain(
  `(()=>{const b=document.querySelector(${JSON.stringify(BTN)});if(!b)return null;b.scrollIntoView({block:'center'});return true;})()`,
);
try {
  await s.click(BTN, { real: true, settle: 1200 });
} catch {
  pausePath = 'video.pause()-button-absent';
  await s.evalMain(`document.querySelector('video')?.pause(); true`);
  await delay(800);
}
out.armA.pause_path = pausePath;
out.armA.before = before;
out.armA.t0 = await state();
if (!out.armA.t0.paused) throw new Error(`user pause did not take: ${JSON.stringify(out.armA.t0)}`);

// ARM A: real elapsed time across >= 2 probe ticks.
const aSamples = [];
for (let i = 0; i < SAMPLES; i++) {
  await delay(SAMPLE_MS);
  aSamples.push({ at_ms: (i + 1) * SAMPLE_MS, ...(await state()) });
}
out.armA.samples = aSamples;
const aDrift = Math.max(...aSamples.map((x) => Math.abs(x.ct - out.armA.t0.ct)));
out.armA.max_ct_drift = +aDrift.toFixed(2);
out.armA.stayed_paused = aSamples.every((x) => x.paused === true);
out.armA.log = await s.evalMain(
  `(window.__koTwitchAdblockStats && {probes: window.__koTwitchAdblockStats.probesTotal ?? null, rewrites: window.__koTwitchAdblockStats.rewrites}) || null`,
);

// ARM B: the same probe path must still resume a video the extension owns.
await s.evalIsolated('KO.twWasPlaying = true; typeof KO.twWasPlaying');
const bStart = Date.now();
let bSample = null;
for (let i = 0; i < 9; i++) {
  await delay(SAMPLE_MS);
  bSample = await state();
  if (!bSample.paused && bSample.ct > out.armA.t0.ct) break;
}
out.armB.elapsed_ms = Date.now() - bStart;
out.armB.after = bSample;
out.armB.resumed = !!bSample && bSample.paused === false && bSample.ct > out.armA.t0.ct + 0.5;

out.pass = out.armA.stayed_paused && out.armA.max_ct_drift < 0.5 && out.armB.resumed;
console.log(JSON.stringify(out, null, 2));
console.log(
  out.pass
    ? 'RESULT PASS d2-real-arm (arm A stayed paused across 50 s, arm B resumed through the same probe path)'
    : 'RESULT FAIL d2-real-arm',
);
cdp.close();
process.exit(out.pass ? 0 : 1);
