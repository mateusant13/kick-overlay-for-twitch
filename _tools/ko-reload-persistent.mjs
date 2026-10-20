#!/usr/bin/env node
// ko-reload-persistent.mjs — reload the unpacked Kick Overlay in the USER'S
// running debug Chrome (port 9222) WITHOUT opening a tab/window and WITHOUT
// killing Chrome.
//
// How: Extensions.getExtensions gives the loaded unpacked path/version. If it
// is stale, create a HIDDEN extension page (Target.createTarget hidden+background,
// not in the tab strip), call chrome.runtime.reload() from it, then re-read the
// version. The hidden target is destroyed by the reload. No UI, no focus.
//
// Usage: node _tools/ko-reload-persistent.mjs [--port=9222] [--dry-run]
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from './ko-cdp.mjs';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const PORT = Number(flag('port', 9222));
const DRY = argv.includes('--dry-run');
const VENDOR = 'C:/Users/Administrador/Desktop/Nova pasta (3)/TESTE/VOD.RIP/vendor/kick-overlay';
const EXPECTED = JSON.parse(readFileSync(`${VENDOR}/manifest.json`, 'utf8')).version;
const ID = 'ojdhhbnnmdhlkinhddgoikfpbhehnojc';

const cdp = await connect(PORT);
const list = async () => {
  const r = await cdp.send('Extensions.getExtensions');
  return (r.extensions || []).find((e) => e.id === ID) || null;
};

const before = await list();
if (!before) {
  console.error(`[reload] KO ${ID} is not installed in the debug profile`);
  cdp.close();
  process.exit(1);
}
console.log(`[reload] loaded=${before.version} expected=${EXPECTED} path=${before.path}`);
if (before.version === EXPECTED) {
  console.log('[reload] already current; nothing to do');
  cdp.close();
  process.exit(0);
}
if (DRY) {
  console.log('[reload] dry-run: would reload via a hidden extension page');
  cdp.close();
  process.exit(0);
}

let targetId;
try {
  // Keep the params minimal: hidden + background is accepted; adding
  // newWindow/forTab (even false) makes Chrome report "Hidden target cannot be
  // created in a new window".
  const created = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${ID}/popup.html`,
    hidden: true,
    background: true,
  });
  targetId = created.targetId;
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await delay(1200);
  const check = await cdp.send('Runtime.evaluate', {
    expression: `({ href: location.href, version: chrome.runtime.getManifest().version })`,
    returnByValue: true,
  }, sessionId);
  console.log('[reload] hidden page', JSON.stringify(check.result?.value));
  // Fire and forget: the context dies with the extension, so the response may
  // never arrive; that is expected.
  cdp.send('Runtime.evaluate', { expression: `chrome.runtime.reload(); true`, returnByValue: true }, sessionId)
    .catch(() => {});
} catch (e) {
  console.error('[reload] could not create/reload via hidden page:', e.message);
  if (targetId) { try { await cdp.send('Target.closeTarget', { targetId }); } catch {} }
  cdp.close();
  process.exit(1);
}

await delay(6000);
let after = null;
try { after = await list(); } catch (e) { console.error('[reload] list after reload failed:', e.message); }
if (targetId) { try { await cdp.send('Target.closeTarget', { targetId }); } catch {} }
console.log(`[reload] after=${after?.version || 'missing'}`);
cdp.close();
process.exit(after?.version === EXPECTED ? 0 : 1);
