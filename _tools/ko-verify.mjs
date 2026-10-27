#!/usr/bin/env node
// Fast evidence gate for the Kick Overlay extension.
//
// This is the JS-extension adaptation of the Sotto observability rules:
//   - one command that produces a receipt with the command and its output;
//   - every detector has a negative arm that is actually executed;
//   - a bug ledger that refuses to call a fix "verified" without independent
//     evidence, and prints FIXED, NOT VERIFIED when it is only fixed;
//   - an explicit NOT MEASURED section.
//
// This gate is deliberately static: no browser, no network, no user's Chrome.
// The live suite is still `node _tools/ko-harness.mjs check ...`.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXT = path.join(ROOT, 'kick-overlay');
const RESULTS = [];
const STARTED = Date.now();
// Raw stdout of the harnesses whose negative arm is the evidence a ledger entry
// cites. The gate writes one _evidence/<bug>-arms.md per key, so a bug marked
// verified has a machine artifact next to the receipt, not a prose claim.
const CAPTURED_ARMS = {};

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function pass(name, detail = '') {
  RESULTS.push({ name, status: 'PASS', detail });
  console.log(`PASS ${name}${detail ? '  ' + detail : ''}`);
}
function fail(name, error) {
  const detail = String(error && error.message ? error.message : error);
  RESULTS.push({ name, status: 'FAIL', detail });
  console.log(`FAIL ${name}  ${detail}`);
}
function check(name, fn) {
  try {
    pass(name, fn());
  } catch (error) {
    fail(name, error);
  }
}

// ---- 1. syntax ------------------------------------------------------------
const PRODUCT_JS = [
  'kick-overlay/background.js',
  'kick-overlay/content.js',
  'kick-overlay/twitch-adblock.js',
  'kick-overlay/player-bridge.js',
  'kick-overlay/adblock-bridge.js',
  'kick-overlay/popup.js',
].filter((rel) => existsSync(path.join(ROOT, rel)));

check('syntax', () => {
  for (const rel of PRODUCT_JS) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], {
      encoding: 'utf8',
    });
    assert(r.status === 0, `${rel}: ${String(r.stderr || r.stdout || '').trim().slice(0, 240)}`);
  }
  return `${PRODUCT_JS.length} files`;
});

// ---- 2. manifest and packaged files --------------------------------------
let manifest = null;
check('manifest', () => {
  manifest = JSON.parse(read('kick-overlay/manifest.json'));
  assert(manifest.manifest_version === 3, 'manifest_version must be 3');
  assert(/^\d+\.\d+\.\d+$/.test(manifest.version), `bad version: ${manifest.version}`);
  for (const rel of ['background.js', 'content.js', 'twitch-adblock.js', 'player.html', 'popup.html']) {
    assert(existsSync(path.join(EXT, rel)), `missing kick-overlay/${rel}`);
  }
  return `${manifest.name} ${manifest.version}`;
});

// ---- 3. no automatic refresh ---------------------------------------------
// The page must never reload itself. This detector is intentionally shared by
// the real check and its negative arm, so the arm proves THIS detector.
const AUTO_REFRESH = /(?:window\.)?location\.(?:reload\s*\(|href\s*=\s*(?:window\.)?location\.href)|http-equiv\s*=\s*["']refresh["']/i;
const AUTO_FILES = [
  'kick-overlay/content.js',
  'kick-overlay/twitch-adblock.js',
  'kick-overlay/background.js',
  'kick-overlay/player-bridge.js',
  'kick-overlay/popup.js',
  'kick-overlay/player.html',
  'kick-overlay/popup.html',
].filter((rel) => existsSync(path.join(ROOT, rel)));
function autoRefreshHits(text) {
  return AUTO_REFRESH.test(text);
}
check('no-auto-refresh', () => {
  const hits = AUTO_FILES.filter((rel) => autoRefreshHits(read(rel)));
  assert(!hits.length, `auto-refresh found in ${hits.join(', ')}`);
  return `${AUTO_FILES.length} files checked`;
});
check('no-auto-refresh.neg-arm', () => {
  assert(autoRefreshHits('window.location.reload();'), 'detector did not reject a reload');
  assert(autoRefreshHits('<meta http-equiv="refresh" content="1">'), 'detector did not reject a meta refresh');
  return 'detector rejected reload and meta refresh';
});

// ---- 4. cold-open standby contract ---------------------------------------
// These are the load-bearing markers of the 0.8.31/0.8.32 cold path. The
// negative arm removes one and requires the detector to fail.
const COLD_CONTRACT = [
  'prewarm.fast',
  'lastStandbyRequestAt',
  'graceMs',
  'requestStandby(0), 200',
  'requestStandby(0), 1000',
  'requestStandby(0), 2500',
  'requestStandby(0), 5000',
  'startLevel: 0',
];
const COLD_TEXT = [read('kick-overlay/twitch-adblock.js'), read('kick-overlay/player-bridge.js')].join('\n');
function coldContract(text) {
  const missing = COLD_CONTRACT.filter((marker) => !text.includes(marker));
  assert(!missing.length, `missing markers: ${missing.join(', ')}`);
  return `${COLD_CONTRACT.length} markers`;
}
check('cold-contract', () => coldContract(COLD_TEXT));
check('cold-contract.neg-arm', () => {
  let rejected = false;
  try {
    coldContract(COLD_TEXT.replace('prewarm.fast', 'removed-on-purpose'));
  } catch {
    rejected = true;
  }
  assert(rejected, 'detector accepted a mutated cold contract');
  return 'detector rejected the missing prewarm.fast';
});

// ---- 5. docs / product decision ------------------------------------------
check('docs', () => {
  assert(existsSync(path.join(EXT, 'PLAYER-1TO1-RESEARCH.md')), 'missing player 1:1 research');
  assert(existsSync(path.join(ROOT, 'README.en.md')), 'missing English README');
  const readme = read('README.md');
  assert(readme.includes('Abrir no site oficial'), 'README does not mention the official-site shortcut');
  assert(readme.includes('PLAYER-1TO1-RESEARCH.md'), 'README does not point to the research');
  return 'research + official-site shortcut documented';
});

// ---- 6. copy slop --------------------------------------------------------
// AGENTS.md forbids AI-slop patterns. This is a smoke test, not a detector for
// every kind of bad prose; the negative arm proves the patterns fire.
const SLOP_PATTERNS = [
  /\bnot just\b/i,
  /\bisn't just\b/i,
  /\bnot only\b/i,
  /\bnão é só\b/i,
  /\bnão é apenas\b/i,
  /\bthe goal is not\b/i,
  /\bo objetivo não é\b/i,
  /\bunlock\b/i,
  /\btransform\b/i,
  /\belevate\b/i,
  /\bempower\b/i,
  /\bstreamline\b/i,
  /\bseamless\b/i,
  /\bdelv(?:e|ing)\b/i,
  /\btapestry\b/i,
  /\bpivotal\b/i,
  /\btestament\b/i,
  /\u2014/,
];
function slopHits(text) {
  return SLOP_PATTERNS.filter((re) => re.test(text)).map((re) => String(re));
}
check('copy-slop', () => {
  const files = ['README.md', 'README.en.md'].filter((rel) => existsSync(path.join(ROOT, rel)));
  const hits = [];
  for (const rel of files) {
    for (const pattern of slopHits(read(rel))) hits.push(`${rel}: ${pattern}`);
  }
  assert(!hits.length, hits.join('; '));
  return `${files.length} files`;
});
check('copy-slop.neg-arm', () => {
  const sample = 'Not just a player. Unlock the future.';
  assert(slopHits(sample).length >= 2, 'detector missed the slop sample');
  return 'detector rejected the slop sample';
});

// ---- 6b. route gate (behavioural, no browser) -----------------------------
// content.js is a position:fixed layer that mirrors a player rect. Both hosts
// keep a ghost player in the DOM after an SPA navigation, so "which routes own
// a mirrored player" is a contract that needs a test, not a comment. This runs
// the real content.js in a stubbed DOM (owner report 2026-10-26:
// twitch.tv/<channel>/clips left the overlay pinned over the clips grid).
check('route-gate', () => {
  const rel = 'kick-overlay/route-gate-test.cjs';
  assert(existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: path.join(ROOT, 'kick-overlay'),
    encoding: 'utf8',
  });
  assert(r.status === 0, `${rel}: ${String(r.stderr || r.stdout || '').trim().slice(-320)}`);
  return 'route contract + hide-on-route-change + no mount on non-player routes';
});

// ---- 6c. mute decision across a player swap (behavioural, no browser) -----
// The ad path replaces the native player with a clean hls.js frame. That frame
// is started muted for autoplay, and the pre-0.8.40 code unmuted it
// unconditionally at reveal, so a user who had muted got sound back on every
// ad pod (owner report 2026-10-26). This runs the real twitch-adblock.js
// against a stubbed DOM through the real ad path and asserts the decision on
// the wire, at the badge and at ad-end; its negative arm replays the pre-fix
// gate and requires the detector to catch it.
check('mute-decision', () => {
  const rel = 'kick-overlay/mute-decision-test.cjs';
  assert(existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: path.join(ROOT, 'kick-overlay'),
    encoding: 'utf8',
  });
  assert(r.status === 0, `${rel}: ${String(r.stderr || r.stdout || '').trim().slice(-320)}`);
  return 'muted reveal + generic click + badge + ad-end, with the pre-fix negative arm';
});

// ---- 6b. bridge handshake (KO-20261026-02) -------------------------------
// The IVS frame's `ready` used to be addressed to a hardcoded twitch.tv origin,
// which the browser drops on a youtube.com page (measured: 0 deliveries), so
// the content script never saw `ready` and the layer stayed a black box. This
// runs the real player-bridge.js against a parent that enforces targetOrigin
// like the browser, plus the pre-fix mutation as a negative arm.
check('bridge-handshake', () => {
  const rel = 'kick-overlay/bridge-handshake-test.cjs';
  assert(existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: path.join(ROOT, 'kick-overlay'),
    encoding: 'utf8',
  });
  assert(r.status === 0, `${rel}: ${String(r.stderr || r.stdout || '').trim().slice(-320)}`);
  return 'ready delivered to a youtube.com parent before learning, exact origin after, with the pre-fix negative arm';
});

// ---- 6c. YouTube resume (owner report 2026-10-26) ------------------------
// resumeNativePagePlayer() started any paused <video>, and probe() runs on a
// 20 s poll plus on every `playing` event, so on a YouTube watch page with
// player=twitch the extension resumed a video the owner had paused himself.
// This runs the real content.js against a stubbed YouTube page and asserts the
// paused video is untouched by a probe; its pre-fix arm removes the ownership
// guard and requires the detector to catch the resume.
check('youtube-resume', () => {
  const rel = 'kick-overlay/youtube-resume-test.cjs';
  assert(existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: path.join(ROOT, 'kick-overlay'),
    encoding: 'utf8',
  });
  CAPTURED_ARMS['KO-20261026-04'] = { check: 'youtube-resume', rel, r };
  assert(r.status === 0, `${rel}: ${String(r.stderr || r.stdout || '').trim().slice(-320)}`);
  return 'user-paused YouTube stays paused across probe(); a video we paused is still handed back (pre-fix arm goes RED)';
});

// ---- 6d. cold-cover fixture (KO-20261023-01) ------------------------------
// A live preroll cannot be manufactured: Twitch served 5 ad-net requests and
// painted no ad in 150 s on live Caedrel (2026-10-26). This fixture manufactures
// the INPUT instead — real m3u8 bytes with the stitched-ad markers, served over
// real HTTP from 127.0.0.1 — then runs the real worker over them and feeds the
// resulting ad-hold into the real page module. GREEN: cold-cover on the hold
// tick, native hidden, reveal inside the 12 s bound. RED: the pre-fix mutation
// (no cold cover) leaves the native ad visible, which the detector must catch.
check('cold-cover-fixture', () => {
  const rel = 'kick-overlay/cold-cover-fixture-test.cjs';
  assert(existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: path.join(ROOT, 'kick-overlay'),
    encoding: 'utf8',
  });
  CAPTURED_ARMS['KO-20261023-01'] = { check: 'cold-cover-fixture', rel, r };
  assert(r.status === 0, `${rel}: ${String(r.stderr || r.stdout || '').trim().slice(-320)}`);
  return 'served ad-only m3u8 -> real worker digest -> ad-hold -> cold-cover on the tick, reveal inside 12 s; pre-fix arm goes RED';
});

// ---- 6e. SPA channel switch (owner report 2026-10-27) ---------------------
// Twitch changes channels without reloading the page. The clean-player overlay
// lives in the same document, and only its invisible STANDBY was guarded
// against a stale channel; a revealed overlay (a live pod) had no path back, so
// after a switch the previous channel's stream stayed on screen with the native
// player hidden ("it keeps the last stream"). This runs the real
// twitch-adblock.js through the real ad path to a revealed overlay, moves the
// pathname the way Twitch does, and asserts the previous channel's player is
// removed, the native is handed back and the next ad cold-starts on the new
// channel; its negative arm disables the guard and requires the detector to
// catch the leak (pre-fix arm goes RED).
check('channel-switch', () => {
  const rel = 'kick-overlay/channel-switch-test.cjs';
  assert(existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: path.join(ROOT, 'kick-overlay'),
    encoding: 'utf8',
  });
  CAPTURED_ARMS['KO-20261027-01'] = { check: 'channel-switch', rel, r };
  assert(r.status === 0, `${rel}: ${String(r.stderr || r.stdout || '').trim().slice(-320)}`);
  return 'revealed + standby overlays dropped on an SPA channel switch, native handed back, same-channel sub-route keeps it; pre-fix arm goes RED';
});

// ---- 7. bug ledger -------------------------------------------------------
// States are explicit. `fixed` is allowed; `verified` needs an independent
// verifier, and `arm-verified` is the narrower claim: the negative arm was
// executed and independently reviewed, while the end-to-end measurement that
// needs the owner's own Chrome is still outstanding and named in
// `owner_validation`. The receipt prints FIXED, NOT VERIFIED only for a fix
// with no measured arm, and ARM-VERIFIED, LIVE PENDING for the narrow one, so
// neither is silent.
const LEDGER_STATES = new Set([
  'reported',
  'reproduced',
  'cause-isolated',
  'fixed',
  'arm-verified',
  'verified',
  'recurrence-watch',
]);
let ledger = { schema: 1, bugs: [] };
check('bug-ledger', () => {
  const raw = JSON.parse(read('_tools/ko-bug-ledger.json'));
  assert(raw && Array.isArray(raw.bugs), 'bug ledger needs a bugs array');
  for (const bug of raw.bugs) {
    assert(bug.id && bug.title, 'bug needs id and title');
    assert(LEDGER_STATES.has(bug.state), `${bug.id}: bad state ${bug.state}`);
    assert(Array.isArray(bug.evidence) && bug.evidence.length > 0, `${bug.id}: fixed without evidence`);
    assert(bug.falsifier, `${bug.id}: hypothesis without falsifier`);
    if (bug.state === 'verified' || bug.state === 'arm-verified') {
      assert(bug.verified_by, `${bug.id}: verified without verifier`);
      assert(bug.verified_by !== bug.author, `${bug.id}: verifier is the author`);
      assert(bug.arms_artifact, `${bug.id}: verified without an arm artifact path`);
      assert(bug.verified_at, `${bug.id}: verified without a date`);
      // Reachability: `verified` needs a real-browser run that actually reached the
      // branch; `arm-verified` needs a reachability attempt that FAILED to reach it.
      // The weaker state cannot be chosen for convenience, only earned by a recorded
      // NO-VERDICT, and the stronger one only by a recorded PASS.
      assert(bug.reachability_artifact, `${bug.id}: no reachability artifact`);
      const rv = bug.reachability_verdict;
      assert(rv === 'PASS' || rv === 'NO-VERDICT', `${bug.id}: reachability_verdict must be PASS or NO-VERDICT`);
      assert(
        (bug.state === 'verified' && rv === 'PASS') || (bug.state === 'arm-verified' && rv === 'NO-VERDICT'),
        `${bug.id}: state ${bug.state} contradicts reachability verdict ${rv}`,
      );
    }
    if (bug.state === 'arm-verified') {
      assert(
        bug.owner_validation,
        `${bug.id}: arm-verified without naming the owner measurement still outstanding`,
      );
    }
  }
  ledger = raw;
  return `${raw.bugs.length} bug(s)`;
});

// ---- 7. receipt ----------------------------------------------------------
const head = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], {
  encoding: 'utf8',
});
const gitHead = String(head.stdout || '').trim() || 'unknown';
const unverified = ledger.bugs.filter((b) => b.state === 'fixed' && b.verified !== true);
const livePending = ledger.bugs.filter((b) => b.state === 'arm-verified');
const NOT_MEASURED = [
  'KO-20261023-01 cold preroll on a real pod: a Twitch-served ad that actually paints, timed in the owner own Chrome. Measured 2026-10-26: 5 ad-net requests and 0 visible-ad samples over 150 s on live Caedrel, so no pod existed to time. Needs the owner browser, not a synthetic input.',
  'KO-20261023-01 cold-cover in a real browser: the real-Chrome attempt (guest profile 9333, live twitch.tv/rodil, real ad-hold posted on the extension own BroadcastChannel) found no `#ko-adfix` frame, so the branch was never reached (`_evidence/KO-20261023-01-real-browser-attempt.txt`, NO-VERDICT). Reaching it needs a standby whose clean player exists, which in practice means the owner own Chrome on a live pod.',
  'KO-20261026-04 behaviour on youtube.com itself: the guest profile is served a YouTube login/bot check, so the guard was proven on a real Twitch watch page through the shared page-player resume path. Confirming it on the owner own YouTube session needs his Chrome.',
  'The installed 0.8.43 build in the owner Chrome after the adblock-standby path runs: unit, gate and guest-Chrome evidence exist, the owner own live session has not been watched yet.',
];
// Measured on a live channel, not in this static gate: the numbers come from
// runs recorded here so the receipt stops claiming they were never taken.
const MEASURED_LIVE = [
  'Heavy `ko-harness.mjs check` suite, 0.8.42, guest Chrome, live channel twitch.tv/n3on (38,305 viewers at discovery): PASS 20, FAIL 1, 71,436 ms. The one failure is `adblock.native-twitch` (native Twitch <video> paused=false rs=0). Re-measured by hand: with the overlay disabled the native video stayed rs=0 / duration null for 24 s on n3on, while the control on twitch.tv/rodil with the overlay disabled played (rs=4, currentTime 13.58 -> 18.49). Native playback for that channel does not start in this profile, with or without the extension; not an overlay defect.',
  'KO-20261026-01 (routes), owner Chrome 0.8.42, live twitch.tv/n3on, real clicks on Clips and Videos: /n3on/clips covered 0 of 22 sampled frames, /n3on/videos covered 0 of 22, back on /n3on covered 32 of 32; Kick layer state null -> Ready. The overlay no longer survives a non-root channel route and returns on the root channel.',
  'KO-20261026-02 (YouTube player=kick black box), owner Chrome 0.8.42: youtube.com/watch?v=0sfDth4lMLc with `ko.v2.player=kick` mapped to live Kick `n3on`. Wrap `ko-kick ko-placed`, firstWrapMs 25, firstPlayingMs 8,856, states null -> Buffering -> Playing, everPlayed true. Player region sampled twice from screenshots: run A mean luminance 35.3 / sd 52.1 / 54.6 % dark, run B mean 34.8 / sd 50.5 / 53.6 % dark, picture moved between samples. A black box would be mean ~0 with sd ~0; this is a playing picture.',
  'KO-20261026-02 long run (stability), owner Chrome 0.8.42, live Kick layer on twitch.tv/n3on, 20 minutes: 120 samples, states {"Playing":120}, playingPct 100, remounts 0, frameSeq [1], single player URL, errors 0, hls events 0, heap 208 -> 76 MB (max 208), no page exceptions; only benign Twitch GraphQL console errors.',
  'KO-20261026-03 (mute across a pod), owner Chrome 0.8.42, live twitch.tv/Caedrel with the native player really playing (rs=4, ct 141.1 s), reveal driven through the real `startAdOverlay` -> healthy gate -> `revealOverlay` path via `stats.testOverlay(<live kick hls>)`. Arm muted: `overlay-reveal` 30,153 ms (reason `playing`), `reveal-muted` 30,158 / 31,100 / 32,094 ms, zero `unmute-ok`, badge "sem anúncio · 1080p · clique para som", revealed frame muted=true rs=4 t=31 s. Arm unmuted: `overlay-reveal` 25,692 ms, `unmute-ok` 27,202 ms, no `reveal-muted`, badge "sem anúncio · 1080p", revealed frame muted=false rs=4 t=32.2 s. Two earlier runs reproduced the same split.',
  'Ad-path wall measured, same channel, 150 s, 141 samples: 5 `ad-net` requests, 0 samples with a visible ad (getBoundingClientRect + computed style + ad label text), 0 native pauses, 0 `cold-cover`, 0 `overlay-reveal`, worker rewriting the playlist to `index-muted-*.m3u8`. Twitch is not painting ads in this profile right now, so a cold preroll could not be timed on a real pod.',
];

const sourceSha = {};
for (const rel of PRODUCT_JS) sourceSha[rel] = sha256(read(rel));
const payload = {
  schema: 1,
  generated_at: new Date().toISOString(),
  elapsed_ms: Date.now() - STARTED,
  git_head: gitHead,
  version: manifest ? manifest.version : null,
  result: 'PASS',
  checks: RESULTS,
  source_sha256: sourceSha,
  bugs: ledger.bugs,
  not_measured: NOT_MEASURED,
  measured_live: MEASURED_LIVE,
};

const evidenceDir = path.join(ROOT, '_evidence');
mkdirSync(evidenceDir, { recursive: true });

// ---- 8. per-bug arm artifacts --------------------------------------------
// A bug is only called verified when its negative arm left a machine artifact
// in _evidence/. Each file carries the command, the source hash that was
// exercised, the RED/mutation lines the harness printed and its full output.
const ARM_SOURCES = {
  'KO-20261023-01': ['kick-overlay/twitch-adblock.js'],
  'KO-20261026-04': ['kick-overlay/content.js'],
  'KO-20261027-01': ['kick-overlay/twitch-adblock.js'],
};
const armArtifacts = [];
for (const [id, sources] of Object.entries(ARM_SOURCES)) {
  const cap = CAPTURED_ARMS[id];
  // The check threw before it captured: write nothing. A missing artifact is
  // visible in arm_artifacts, while a fabricated one would not be.
  if (!cap) continue;
  const out = `${cap.r.stdout || ''}${cap.r.stderr || ''}`;
  const verdict = RESULTS.find((r) => r.name === cap.check);
  const arms = out
    .split(/\r?\n/)
    .filter((line) => /\bRED\b|mutation|EXPECTED-RED/.test(line))
    .map((line) => line.trim());
  const body = [
    `# ${id} — executed arms`,
    '',
    `- generated: ${payload.generated_at}`,
    `- git: ${gitHead}`,
    `- extension: ${payload.version}`,
    `- command: node ${cap.rel}  (cwd kick-overlay)`,
    `- check: ${cap.check} -> ${verdict ? verdict.status : 'MISSING'}, exit=${cap.r.status}`,
    ...sources.map((rel) => `- source: ${rel} sha256=${sha256(read(rel))}`),
    '',
    '## arm lines (extracted from the captured output)',
    '',
    ...(arms.length ? arms.map((line) => `- ${line}`) : ['- none matched: the negative arm did not print']),
    '',
    '## captured output',
    '',
    '```',
    out.trimEnd(),
    '```',
    '',
    'EXPECTED-RED is a control, not a product failure: the pre-fix mutation has to',
    'fail at the detector that names the defect, which is what the RED line above',
    'reports. A green file with no RED line means the control did not fire.',
    '',
  ].join('\n');
  const rel = path.join('_evidence', `${id}-arms.md`);
  writeFileSync(path.join(ROOT, rel), body);
  armArtifacts.push({
    id,
    path: rel.split(path.sep).join('/'),
    check: cap.check,
    status: verdict ? verdict.status : 'MISSING',
    expected_red: arms.length > 0,
  });
}
payload.arm_artifacts = armArtifacts;

// Every bug that claims a measured arm must point at an artifact this run just
// wrote, and that artifact must carry a RED/mutation line. Deleting a harness's
// negative arm, or pointing the ledger at a stale file, turns this check RED.
check('verified-artifacts', () => {
  const claimed = ledger.bugs.filter((b) => b.state === 'verified' || b.state === 'arm-verified');
  for (const bug of claimed) {
    assert(bug.arms_artifact, `${bug.id}: no arms_artifact`);
    const abs = path.join(ROOT, bug.arms_artifact);
    assert(existsSync(abs), `${bug.id}: missing ${bug.arms_artifact}`);
    const body = readFileSync(abs, 'utf8');
    assert(/RED|mutation/i.test(body), `${bug.id}: ${bug.arms_artifact} has no RED/mutation line`);
    const generated = /generated:\s*(\S+)/.exec(body);
    assert(generated, `${bug.id}: artifact has no generated stamp`);
    const ageH = (Date.now() - Date.parse(generated[1])) / 3600e3;
    assert(ageH < 24, `${bug.id}: artifact is ${ageH.toFixed(1)} h old; re-run the gate`);

    // Reachability artifacts come from a browser run, so they are not regenerated
    // by this gate and cannot be age-failed; they must exist and agree with the
    // verdict the ledger claims. The receipt prints their age so nobody reads a
    // three-day-old browser run as a live measurement.
    const rAbs = path.join(ROOT, bug.reachability_artifact);
    assert(
      existsSync(rAbs),
      `${bug.id}: missing ${bug.reachability_artifact}; regenerate it with node _tools/ko-real-arm-${bug.id === 'KO-20261023-01' ? 'd1' : 'd2'}.mjs against the guest harness`,
    );
    const rBody = readFileSync(rAbs, 'utf8');
    assert(
      rBody.includes(`RESULT ${bug.reachability_verdict}`),
      `${bug.id}: ${bug.reachability_artifact} does not say RESULT ${bug.reachability_verdict}`,
    );
    // A reachability record from before the source changed says nothing about the
    // code that shipped afterwards: re-running the arm script is the price of
    // keeping the claim.
    const srcLines = [...body.matchAll(/^- source: (\S+) sha256=/gm)].map((m) => m[1]);
    assert(srcLines.length > 0, `${bug.id}: ${bug.arms_artifact} names no source file`);
    const reachMtime = statSync(rAbs).mtimeMs / 1000;
    for (const rel of srcLines) {
      const log = spawnSync('git', ['-C', ROOT, 'log', '-1', '--format=%ct', '--', rel], { encoding: 'utf8' });
      const committed = Number(String(log.stdout || '').trim());
      if (!Number.isFinite(committed) || !committed) continue; // untracked source: nothing to compare
      assert(
        reachMtime >= committed,
        `${bug.id}: ${bug.reachability_artifact} is older than the last change to ${rel} (${new Date(committed * 1000).toISOString()}); re-run node _tools/ko-real-arm-${bug.id === 'KO-20261023-01' ? 'd1' : 'd2'}.mjs`,
      );
    }
    const ageDays = (Date.now() - statSync(rAbs).mtimeMs) / 86400e3;
    armArtifacts.push({
      id: bug.id,
      path: bug.reachability_artifact,
      check: 'reachability',
      status: bug.reachability_verdict,
      expected_red: null,
      age_days: +ageDays.toFixed(2),
      after_source_change: true,
    });
  }
  return `${claimed.length} claim(s) bound to a fresh arm artifact and a reachability record`;
});

const failed = RESULTS.filter((r) => r.status === 'FAIL');
payload.result = failed.length ? 'FAIL' : 'PASS';
writeFileSync(path.join(evidenceDir, 'ko-verify-latest.json'), JSON.stringify(payload, null, 2) + '\n');

const lines = [
  '# KO fast verification receipt',
  '',
  `- generated: ${payload.generated_at}`,
  `- git: ${gitHead}`,
  `- extension: ${payload.version}`,
  `- result: **${payload.result}**`,
  `- elapsed: ${payload.elapsed_ms} ms`,
  '',
  '## Checks',
  '',
  '| Check | Status | Detail |',
  '| --- | --- | --- |',
  ...RESULTS.map((r) => `| ${r.name} | ${r.status} | ${String(r.detail).replace(/\|/g, '\\|')} |`),
  '',
  '## Negative arms (machine files)',
  '',
  ...(armArtifacts.length
    ? armArtifacts.map((a) =>
        a.check === 'reachability'
          ? `- ${a.id}: ${a.path} — reachability ${a.status}, recorded ${a.age_days} day(s) ago, newer than the last change to its source (browser run, not regenerated by this gate)`
          : `- ${a.id}: ${a.path} — ${a.check} ${a.status}, RED/mutation line present=${a.expected_red}`,
      )
    : ['- none']),
  '',
  '## Bugs',
  '',
  ...(ledger.bugs.length
    ? ledger.bugs.map(
        (b) =>
          `- **${b.id}** ${b.title}: state=\`${b.state}\`, verified=${b.verified === true ? 'true' : 'false'}${b.arms_artifact ? `, arms: ${b.arms_artifact}` : ''}${b.verified_by ? `, verifier: ${b.verified_by}` : ''}${b.owner_validation ? `, owner validation: ${b.owner_validation}` : ''}${b.next ? `, next: ${b.next}` : ''}`,
      )
    : ['- none']),
  '',
  '## Measured live (not by this static gate)',
  '',
  ...(MEASURED_LIVE.length ? MEASURED_LIVE.map((item) => `- ${item}`) : ['- none recorded']),
  '',
  '## NOT MEASURED',
  '',
  ...NOT_MEASURED.map((item) => `- ${item}`),
  '',
  'This receipt is generated by `_tools/ko-verify.mjs`. It proves the static',
  'checks above and the negative arms that were actually executed. It does not',
  'prove runtime behavior in the owner Chrome.',
  '',
];
writeFileSync(path.join(evidenceDir, 'ko-verify-latest.md'), lines.join('\n'));

console.log('');
if (unverified.length) {
  console.log('='.repeat(64));
  console.log(`FIXED, NOT VERIFIED: ${unverified.map((b) => b.id).join(', ')}`);
  console.log('='.repeat(64));
  console.log('');
}
if (livePending.length) {
  console.log(
    `ARM-VERIFIED, LIVE PENDING: ${livePending.map((b) => `${b.id} (${b.owner_validation})`).join('; ')}`,
  );
}
console.log(`RESULT ${payload.result}  checks=${RESULTS.length}  failed=${failed.length}`);
console.log(`RECEIPT ${path.relative(ROOT, path.join(evidenceDir, 'ko-verify-latest.md'))}`);
console.log(`NOT MEASURED ${NOT_MEASURED.length} item(s); see the receipt`);
if (failed.length) {
  for (const r of failed) console.log(`  - ${r.name}: ${r.detail}`);
  process.exitCode = 1;
}
