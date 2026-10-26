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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXT = path.join(ROOT, 'kick-overlay');
const RESULTS = [];
const STARTED = Date.now();

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

// ---- 7. bug ledger -------------------------------------------------------
// States are explicit. `fixed` is allowed; `verified` needs an independent
// verifier. The receipt always prints FIXED, NOT VERIFIED for fixed-but-
// unverified entries instead of letting a commit message imply closure.
const LEDGER_STATES = new Set([
  'reported',
  'reproduced',
  'cause-isolated',
  'fixed',
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
    if (bug.state === 'verified') {
      assert(bug.verified_by, `${bug.id}: verified without verifier`);
      assert(bug.verified_by !== bug.author, `${bug.id}: verifier is the author`);
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
const failed = RESULTS.filter((r) => r.status === 'FAIL');
const unverified = ledger.bugs.filter((b) => b.state === 'fixed' && b.verified !== true);
const NOT_MEASURED = [
  'A real cold preroll in the owner Chrome on 0.8.32 (the live harness is separate).',
  'Long-run stability on a real live stream; only short Edge runs were observed.',
  'The Edge synthetic timings (136-547 ms) are not a substitute for the owner measurement.',
  'The heavy `ko-harness.mjs check` suite; this gate is static and does not start a browser.',
  'A JS-side profiler; no equivalent of the Sotto py-spy run exists yet.',
];

const sourceSha = {};
for (const rel of PRODUCT_JS) sourceSha[rel] = sha256(read(rel));
const payload = {
  schema: 1,
  generated_at: new Date().toISOString(),
  elapsed_ms: Date.now() - STARTED,
  git_head: gitHead,
  version: manifest ? manifest.version : null,
  result: failed.length ? 'FAIL' : 'PASS',
  checks: RESULTS,
  source_sha256: sourceSha,
  bugs: ledger.bugs,
  not_measured: NOT_MEASURED,
};

const evidenceDir = path.join(ROOT, '_evidence');
mkdirSync(evidenceDir, { recursive: true });
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
  '## Bugs',
  '',
  ...(ledger.bugs.length
    ? ledger.bugs.map(
        (b) =>
          `- **${b.id}** ${b.title}: state=\`${b.state}\`, verified=${b.verified === true ? 'true' : 'false'}${b.next ? `, next: ${b.next}` : ''}`,
      )
    : ['- none']),
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
console.log(`RESULT ${payload.result}  checks=${RESULTS.length}  failed=${failed.length}`);
console.log(`RECEIPT ${path.relative(ROOT, path.join(evidenceDir, 'ko-verify-latest.md'))}`);
console.log(`NOT MEASURED ${NOT_MEASURED.length} item(s); see the receipt`);
if (failed.length) {
  for (const r of failed) console.log(`  - ${r.name}: ${r.detail}`);
  process.exitCode = 1;
}
