// Channel-switch regression harness for twitch-adblock.js.
//
// Owner report (2026-10-27): "make the stream actually change when i change
// channels, cause today it keeps the last stream".
//
// Twitch swaps channels with an SPA navigation: no reload, same page, same
// script instance. The clean-player overlay lives in that instance. Every path
// that learns about a channel (standby-start, ad-hold) compares the message
// channel with the page only while the overlay is an invisible STANDBY; an
// overlay that is already revealed (a live ad pod) has no channel check and no
// pathname watcher, so after a channel switch it keeps the previous channel's
// clean stream on screen and keeps the native player hidden. Nothing in this
// module watched the pathname (grep: no popstate/pushState/interval).
//
// This harness runs the REAL twitch-adblock.js against the shared stubbed DOM
// and drives the real ad path to a revealed overlay, then moves the page to
// another channel the way Twitch does — location.pathname changes under the
// same document — and asserts the previous channel's player is handed back.
// `node channel-switch-test.cjs` (no frameworks).
//
// Negative arm: the same scenarios run against a copy with the channel guard
// disabled (`&& false`), which is exactly the pre-fix behavior. The revealed
// arm MUST fail there, otherwise the detector measures nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const { makePage, runPod, settle, healthySt } = require('./mute-decision-test.cjs');

const SOURCE = fs.readFileSync(path.join(__dirname, 'twitch-adblock.js'), 'utf8');
// The pre-fix behavior: the channel-change stop never fires.
const PRE_FIX_MUTATION = ['if (overlay.frame && oc !== ch) {', 'if (overlay.frame && oc !== ch && false) {'];

const WATCH = 1400; // > the module's 900 ms pathname cadence

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, status: 'FAIL', detail: error.message });
    console.log(`FAIL ${name}  ${error.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function revealedPod(page) {
  await runPod(page, { mutedBeforeAd: false });
}

async function main() {
  // ---- 1: the owner's report. A revealed clean player survives the switch. --
  {
    const page = makePage();
    await revealedPod(page);
    const frameAtReveal = page.frame;
    check('precondition: a revealed clean player covers the native surface', () => {
      assert(frameAtReveal && !frameAtReveal.removed, 'no clean frame was created');
      assert(String(frameAtReveal.style.opacity) === '1', `frame opacity ${frameAtReveal.style.opacity}`);
      assert(page.video.style.visibility === 'hidden', `native visibility ${page.video.style.visibility}`);
    });

    // Twitch's SPA switch: same document, new pathname.
    page.location.pathname = '/necros';
    await settle(WATCH);

    check('a revealed overlay of the previous channel is stopped on a channel switch', () => {
      assert(frameAtReveal.removed === true, 'the previous channel clean player is still attached');
    });
    check('the native player is handed back after the switch', () => {
      assert(page.video.style.visibility !== 'hidden', `native still hidden (${page.video.style.visibility})`);
    });
  }

  // ---- 2: the next ad on the new channel starts a NEW player. -------------
  {
    const page = makePage();
    await revealedPod(page);
    const oldFrame = page.frame;
    const before = page.sent.length;
    page.location.pathname = '/necros';
    await settle(WATCH);
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/necros.m3u8', channel: 'necros' });
    await settle(700); // startAdOverlay hands the url to the frame at +400 ms
    check('an ad on the new channel cold-starts its own clean player', () => {
      const loads = page.sent.slice(before).filter((m) => m && m.t === 'load').map((m) => m.url);
      assert(loads.some((u) => String(u).includes('necros.m3u8')), `loads after the switch: ${JSON.stringify(loads)}`);
      assert(!loads.some((u) => String(u).includes('rodil')), 'the previous channel url was reused');
      assert(page.frame && page.frame !== oldFrame, 'the old frame was adopted for the new channel');
    });
  }

  // ---- 3: an invisible standby from the previous channel is also dropped. --
  {
    const page = makePage();
    page.video.muted = false;
    page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt());
    const standby = page.frame;
    check('precondition: a hidden standby exists without covering the page', () => {
      assert(standby && !standby.removed, 'no standby frame');
      assert(String(standby.style.opacity) !== '1', `standby is visible (${standby.style.opacity})`);
      assert(page.video.style.visibility !== 'hidden', `native visibility ${page.video.style.visibility}`);
    });
    page.location.pathname = '/necros';
    await settle(WATCH);
    check('a hidden standby of the previous channel is dropped on a channel switch', () => {
      assert(standby.removed === true, 'the previous channel standby is still attached');
    });
  }

  // ---- 4: no false positive. Same channel, different sub-route. -----------
  {
    const page = makePage();
    await revealedPod(page);
    const frame = page.frame;
    page.location.pathname = '/rodil/clips';
    await settle(WATCH);
    check('a sub-route of the SAME channel keeps the overlay', () => {
      assert(frame.removed === false, 'the overlay was stopped although the channel did not change');
    });
  }

  // ---- 5: negative arm. Guard disabled = pre-fix behavior. ---------------
  {
    const mutated = SOURCE.split(PRE_FIX_MUTATION[0]).join(PRE_FIX_MUTATION[1]);
    check('negative arm: the pre-fix mutation applied', () => {
      assert(mutated !== SOURCE, 'the pre-fix mutation did not apply (guard text moved?)');
    });
    const page = makePage(mutated);
    await revealedPod(page);
    const frame = page.frame;
    page.location.pathname = '/necros';
    await settle(WATCH);
    check('negative arm: without the guard the old channel player IS kept (caught)', () => {
      assert(frame.removed === false, 'the detector accepted the pre-fix behavior — it measures nothing');
      assert(page.video.style.visibility === 'hidden', 'native was restored in the mutant; the arm is not testing the guard');
    });
  }

  const failed = checks.filter((c) => c.status === 'FAIL');
  console.log('');
  console.log(`RESULT ${failed.length ? 'FAIL' : 'PASS'} channel-switch checks=${checks.length} failed=${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('\nRESULT FAIL', error && error.message ? error.message : error);
    process.exit(1);
  });
} else {
  module.exports = { main };
}
