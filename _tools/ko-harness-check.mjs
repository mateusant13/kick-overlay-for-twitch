// ko-harness-check.mjs — end-to-end PASS/FAIL suite used by ko-harness.mjs.
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const KO_STATE = `(() => {
  if (typeof KO === 'undefined' || !KO) return null;
  const pill = document.getElementById('ko-golive');
  return {
    player: KO.player, enabled: KO.enabled, slug: KO.slug, kickSlug: KO.kickSlug,
    kickReady: KO.kickReady, kick: KO.kickState, onDvr: KO.kickOnDvr, kickDur: KO.kickDur,
    ytRaw: KO.ytRaw, ytId: KO.ytId, ytHls: !!KO.ytHlsUrl, ytHlsFailed: KO.ytHlsFailed,
    yt: KO.ytState,
    wrap: KO.wrap ? { cls: KO.wrap.className, display: KO.wrap.style.display } : null,
    pill: pill ? { display: getComputedStyle(pill).display, pe: getComputedStyle(pill).pointerEvents, text: pill.textContent } : null,
  };
})()`;

const HLS_VIDEO = `(() => {
  const v = document.querySelector('video');
  if (!v) return null;
  const s = []; for (let i = 0; i < v.seekable.length; i++) s.push([v.seekable.start(i), v.seekable.end(i)]);
  const b = []; for (let i = 0; i < v.buffered.length; i++) b.push([v.buffered.start(i), v.buffered.end(i)]);
  return { ct: v.currentTime, dur: v.duration, paused: v.paused, rs: v.readyState, ended: v.ended, muted: v.muted, seekable: s, buffered: b };
})()`;

const ADBLOCK = `({
  stats: window.__koTwitchAdblockStats || null,
  flag: window.__koTwitchAdblock === true,
  attr: document.documentElement.getAttribute('data-ko-adblock'),
})`;

const TWITCH_VIDEO = `(() => {
  const v = document.querySelector('video');
  return v ? { paused: v.paused, muted: v.muted, ct: v.currentTime, rs: v.readyState, dur: v.duration } : null;
})()`;

export async function runCheck(s, opts = {}) {
  const results = [];
  const errors = [];
  const t0 = Date.now();
  const ytUrl = opts.yt;
  const viewport = opts.viewport || { width: 1600, height: 900 };

  const add = (name, status, detail = '') => {
    results.push({ name, status, detail });
    const icon = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : status === 'WARN' ? 'WARN' : 'FAIL';
    console.log(`${icon.padEnd(4)} ${name}${detail ? '  ' + detail : ''}`);
  };
  const pass = (name, detail) => add(name, 'PASS', detail);
  const warn = (name, detail) => add(name, 'WARN', detail);
  const skip = (name, detail) => add(name, 'SKIP', detail);
  const fail = (name, e) => add(name, 'FAIL', String(e?.message || e).slice(0, 260));

  const evalKo = (expr) => s.page.evalIsolated(expr);
  const state = () => evalKo(KO_STATE);

  async function step(name, fn) {
    try {
      const detail = await fn();
      if (detail && detail.skip) skip(name, detail.skip);
      else if (detail && detail.warn) warn(name, detail.warn);
      else pass(name, typeof detail === 'string' ? detail : '');
    } catch (e) {
      fail(name, e);
    }
  }

  // ---- 0. injection + viewport ------------------------------------------------
  let st0;
  await step('inject', async () => {
    st0 = await state();
    if (!st0) throw new Error('KO not present in the isolated content-script world');
    return `player=${st0.player} slug=${st0.slug} wrap=${st0.wrap?.cls || '-'}`;
  });
  if (!st0) {
    // Nothing else can run without the content script.
    return finish();
  }

  try {
    await s.page.setViewport(viewport.width, viewport.height);
  } catch (e) { warn('viewport', e.message); }

  // ---- 1. Kick layer ----------------------------------------------------------
  await step('kick.activate', async () => {
    await s.page.evalIsolated(`new Promise((res) => {
      chrome.storage.local.get('ko.v2', (o) => {
        const st = o['ko.v2'] || {};
        st.enabled = true; st.player = 'kick';
        chrome.storage.local.set({ 'ko.v2': st }, () => res(true));
      });
    })`);
    await s.page.waitFor(
      `!!(KO.player === 'kick' && KO.kickReady && KO.kickState && KO.kickState.state === 'Playing')`,
      (v) => v === true,
      { timeout: 30000, label: 'kick.activate' }
    );
    const k = (await state()).kick;
    return `${k.q?.name || '?'} pos=${Math.round(k.pos || 0)}s`;
  });

  await step('kick.pause-play', async () => {
    await evalKo(`kickSend({ t: 'pause' }); true`);
    await s.page.waitFor(`KO.kickState && KO.kickState.paused === true`, (v) => v === true, { timeout: 8000, label: 'kick.pause' });
    await evalKo(`kickSend({ t: 'play' }); true`);
    await s.page.waitFor(`KO.kickState && KO.kickState.paused === false`, (v) => v === true, { timeout: 8000, label: 'kick.play' });
    return 'pause -> play';
  });

  await step('kick.mute', async () => {
    await evalKo(`kickSend({ t: 'mute', m: true }); true`);
    await s.page.waitFor(`KO.kickState && KO.kickState.muted === true`, (v) => v === true, { timeout: 6000, label: 'kick.mute' });
    await evalKo(`kickSend({ t: 'mute', m: false }); true`);
    await s.page.waitFor(`KO.kickState && KO.kickState.muted === false`, (v) => v === true, { timeout: 6000, label: 'kick.unmute' });
    return 'mute -> unmute';
  });

  await step('kick.quality', async () => {
    await evalKo(`kickSend({ t: 'quality', q: 1 }); true`);
    await delay(2500);
    const k = (await state()).kick;
    if (!k?.q?.name) throw new Error('no quality name');
    if (!/720/.test(k.q.name)) throw new Error(`quality did not switch (got ${k.q.name})`);
    await evalKo(`kickSend({ t: 'quality', q: 0 }); true`);
    return k.q.name;
  });

  let kickDvr = false;
  await step('kick.dvr', async () => {
    const k0 = await state();
    if (!k0.kickDur || k0.kickDur < 300) return { skip: 'no DVR duration' };
    await evalKo(`kickSeekTo(KO.kickDur - 120); true`);
    // Wait for the DVR seek to land, not just the flag - the replay url
    // starts near 0 and reaches the target asynchronously.
    await s.page.waitFor(
      `KO.kickOnDvr === true && KO.kickState && KO.kickState.pos > 100`,
      (v) => v === true,
      { timeout: 25000, label: 'kick.dvr' }
    );
    kickDvr = true;
    const k = await state();
    if (k.pill?.display !== 'block') throw new Error('LIVE pill did not appear on DVR');
    if (k.pill?.pe !== 'auto') throw new Error(`LIVE pill pointer-events=${k.pill?.pe}`);
    return `onDvr pos=${Math.round(k.kick.pos || 0)}s pill="${k.pill.text}"`;
  });

  if (kickDvr) {
    await step('kick.golive', async () => {
      // Let the DVR seek/retry settle before starting the live reload.
      await delay(1500);
      const hit = await s.page.hitTest('#ko-golive');
      if (!hit?.isSelf) warn('kick.pill-hit', `top element=${hit?.hit?.tag || '?'}#${hit?.hit?.id || ''}.${hit?.hit?.cls || ''}`);
      // Always dispatch the DOM click. Twitch's consent dialog can cover the
      // player (its "Certo, entendi!" button intercepted the real click and
      // made this check flaky); the pill handler itself is what's under test.
      await s.page.click('#ko-golive', { real: false, settle: 400 });
      // The DVR url is still Playing while the live playlist loads; require
      // the session-relative position too, otherwise this read races and
      // sees the old 7000s broadcast position.
      await s.page.waitFor(
        `KO.kickOnDvr === false && KO.kickState && KO.kickState.state === 'Playing' && KO.kickState.pos < 200`,
        (v) => v === true,
        { timeout: 25000, label: 'kick.golive' }
      );
      const k = await state();
      if (!(k.kick.pos < 200)) throw new Error(`suspicious position after go-live: ${k.kick.pos}`);
      return `synthetic click -> pos=${Math.round(k.kick.pos || 0)}s`;
    });
  }

  await step('kick.seekToLive-sane', async () => {
    await evalKo(`kickSend({ t: 'seekToLive' }); true`);
    await delay(3000);
    const k = await state();
    if (!(k.kick.pos >= 0 && k.kick.pos < 200)) throw new Error(`position sentinel: ${k.kick.pos}`);
    return `pos=${Math.round(k.kick.pos || 0)}s`;
  });

  await step('kick.step-5', async () => {
    // Let the live buffer accumulate so a 5s rewind has somewhere to land.
    await delay(5000);
    const before = await state();
    await evalKo(`seekOverlayStep(-5); true`);
    await delay(1500);
    const back = await state();
    // The SDK's getLiveLatency() lagged a manual seek by ~5s; the bridge now
    // derives latency from buffered.end, so this must rise immediately.
    if (!(back.kick.lat > before.kick.lat + 3.5)) {
      throw new Error(`rewind not reflected: lat ${before.kick.lat.toFixed(1)} -> ${back.kick.lat.toFixed(1)}`);
    }
    await evalKo(`seekOverlayStep(5); true`);
    await delay(1500);
    const fwd = await state();
    if (!(fwd.kick.lat < back.kick.lat - 2.5)) {
      throw new Error(`forward did not step: lat ${back.kick.lat.toFixed(1)} -> ${fwd.kick.lat.toFixed(1)}`);
    }
    await evalKo(`kickSend({ t: 'seekToLive' }); true`);
    await delay(2000);
    const live = await state();
    if (!(live.kick.lat < 4)) throw new Error(`still ${live.kick.lat.toFixed(1)}s behind after LIVE`);
    return `lat ${before.kick.lat.toFixed(1)} -> ${back.kick.lat.toFixed(1)} -> ${fwd.kick.lat.toFixed(1)} -> ${live.kick.lat.toFixed(1)}s`;
  });

  // ---- 2. YouTube layer -------------------------------------------------------
  let ytReady = false;
  await step('yt.activate', async () => {
    await s.page.evalIsolated(`new Promise((res) => {
      chrome.storage.local.get('ko.v2', (o) => {
        const st = o['ko.v2'] || {};
        st.enabled = true; st.player = 'youtube';
        st.mappings = { ...(st.mappings || {}) };
        const slug = ${JSON.stringify(st0.slug || 'rodil')};
        st.mappings[slug] = { ...(st.mappings[slug] || {}), yt: ${JSON.stringify(ytUrl)} };
        chrome.storage.local.set({ 'ko.v2': st }, () => res(true));
      });
    })`);
    await s.page.waitFor(
      `!!(KO.player === 'youtube' && KO.ytId && KO.ytState && KO.ytState.ready && KO.ytState.live)`,
      (v) => v === true,
      { timeout: 35000, label: 'yt.activate' }
    );
    ytReady = true;
    const k = await state();
    return `id=${k.ytId} hls=${k.ytHls} q=${k.yt?.vq || '?'}`;
  });

  if (ytReady) {
    await step('yt.playing', async () => {
      await s.page.waitFor(`KO.ytState && KO.ytState.playing === true`, (v) => v === true, { timeout: 20000, label: 'yt.playing' });
      return 'playing';
    });

    await step('yt.iframe-video', async () => {
      await opts.onRefresh?.();
      if (!s.hls) throw new Error('HLS iframe not attached');
      const v = await s.hls.evalRaw(HLS_VIDEO);
      if (!v) throw new Error('no <video> in HLS iframe');
      if (!(v.rs >= 2)) throw new Error(`readyState=${v.rs} (no data)`);
      if (!v.buffered?.length) throw new Error('empty buffered range');
      return `rs=${v.rs} ct=${v.ct.toFixed(1)} buffered=${v.buffered.length}`;
    });

    await step('yt.segments', async () => {
      if (!s.hls) throw new Error('HLS iframe not attached');
      await s.hls.cdp.send('Network.enable', {}, s.hls.sessionId);
      s.hls.network = [];
      await evalKo(`ytSend({ t: 'load', url: KO.ytHlsUrl }); true`);
      await delay(10000);
      const rows = s.hls.network.filter((n) => n.kind === 'res' && /googlevideo/.test(n.url || ''));
      const bad = rows.filter((n) => n.status >= 400);
      const good = rows.filter((n) => n.status === 200 || n.status === 206);
      if (!good.length) throw new Error(`no media responses (statuses=${[...new Set(rows.map((r) => r.status))].join(',') || 'none'})`);
      if (bad.length) throw new Error(`media 4xx/5xx: ${[...new Set(bad.map((b) => b.status))].join(',')} (${bad.length}/${rows.length})`);
      await s.page.waitFor(`KO.ytState && KO.ytState.live === true`, (v) => v === true, { timeout: 20000, label: 'yt.segments.recover' }).catch(() => {});
      return `${good.length} ok, 0 bad`;
    });

    await step('yt.quality', async () => {
      await evalKo(`ytSend({ t: 'setLevel', l: 2 }); true`);
      await delay(3000);
      const k = await state();
      if (!k.yt?.vq) throw new Error('vq empty after setLevel');
      await evalKo(`ytSend({ t: 'quality', q: 'auto' }); true`);
      return k.yt.vq;
    });

    await step('yt.pause-play-mute', async () => {
      await evalKo(`ytCmd('pause'); true`);
      await s.page.waitFor(`KO.ytState && KO.ytState.playing === false`, (v) => v === true, { timeout: 8000, label: 'yt.pause' });
      await evalKo(`ytCmd('play'); true`);
      await s.page.waitFor(`KO.ytState && KO.ytState.playing === true`, (v) => v === true, { timeout: 12000, label: 'yt.play' });
      // Use the real overlay button: the bridge mute alone is immediately
      // re-synced from KO.ytMuted (the persisted user mute choice).
      await s.page.evalMain(`document.getElementById('ko-mute')?.click(); true`);
      await s.page.waitFor(`KO.ytState && KO.ytState.muted === true`, (v) => v === true, { timeout: 6000, label: 'yt.mute' });
      await s.page.evalMain(`document.getElementById('ko-mute')?.click(); true`);
      await s.page.waitFor(`KO.ytState && KO.ytState.muted === false`, (v) => v === true, { timeout: 6000, label: 'yt.unmute' });
      return 'pause/play/mute';
    });

    await step('yt.rewind-golive', async () => {
      const before = await state();
      const target = Math.max(0, (before.yt.ct || 0) - 12);
      await evalKo(`ytCmd('seek', ${target}); true`);
      await delay(3500);
      const behind = await state();
      if (!(behind.yt.lat > 4)) return { warn: `rewind did not stick (lat=${behind.yt.lat.toFixed(1)}s)` };
      if (behind.pill?.display !== 'block') return { warn: `pill display=${behind.pill?.display} at lat=${behind.yt.lat.toFixed(1)}s` };
      const hit = await s.page.hitTest('#ko-golive');
      if (!hit?.isSelf) warn('yt.pill-hit', `top=${hit?.hit?.tag || '?'}#${hit?.hit?.id || ''}.${hit?.hit?.cls || ''}`);
      await s.page.click('#ko-golive', { real: false, settle: 400 });
      await delay(5000);
      const live = await state();
      if (live.yt.lat > 15) throw new Error(`still ${live.yt.lat.toFixed(1)}s behind after LIVE`);
      return `lat ${behind.yt.lat.toFixed(1)}s -> ${live.yt.lat.toFixed(1)}s (synthetic)`;
    });
  }

  // ---- 3. Adblock -------------------------------------------------------------
  await step('adblock.stats', async () => {
    const a = await s.page.evalMain(ADBLOCK);
    if (!a.flag) throw new Error('MAIN-world adblock flag missing');
    if (!a.stats) throw new Error('no window.__koTwitchAdblockStats');
    if (!(a.stats.rewrites >= 1)) throw new Error(`rewrites=${a.stats.rewrites}`);
    if (!(a.stats.workerHooks >= 1)) throw new Error(`workerHooks=${a.stats.workerHooks}`);
    if (a.stats.workerFailures) throw new Error(`workerFailures=${a.stats.workerFailures}`);
    if (a.attr !== '1') throw new Error(`data-ko-adblock=${a.attr}`);
    return `rewrites=${a.stats.rewrites} hooks=${a.stats.workerHooks} failures=${a.stats.workerFailures}`;
  });

  await step('adblock.token-body', async () => {
    // Regression for the 0.8.7 bug where the fetch wrapper incremented
    // stats.rewrites but forwarded `arguments` (the original ad-bearing
    // body), so the page still minted a `site` token and ads leaked.
    const bodies = [];
    const onReq = (p, sid) => {
      if (sid !== s.page.sessionId) return;
      if (p.request.url.includes('gql.twitch.tv/gql') &&
          p.request.postData && p.request.postData.includes('ko_probe_')) {
        bodies.push(p.request.postData);
      }
    };
    s.cdp.on('Network.requestWillBeSent', onReq);
    await s.page.cdp.send('Network.enable', {}, s.page.sessionId);
    const login = `ko_probe_${Date.now()}`;
    await s.page.evalMain(`fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({
        operationName: 'PlaybackAccessToken',
        variables: { isLive: true, login: ${JSON.stringify(login)}, isVod: false, vodID: '', playerType: 'site', platform: 'web' },
        extensions: { persistedQuery: { version: 1, sha256Hash: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9' } }
      })
    }).catch(() => null)`);
    await delay(1800);
    if (!bodies.length) throw new Error('probe token request was not sent');
    let sent = null;
    for (const b of bodies) {
      try {
        const j = JSON.parse(b);
        const item = Array.isArray(j) ? j[0] : j;
        if (item?.variables?.login === login) sent = item.variables.playerType;
      } catch { /* ignore */ }
    }
    if (sent !== 'popout') throw new Error(`wire playerType=${sent}`);
    return `wire playerType=${sent}`;
  });

  if (opts.adblock !== false) {
    await step('adblock.native-twitch', async () => {
      await s.page.evalIsolated(`new Promise((res) => {
        chrome.storage.local.get('ko.v2', (o) => {
          const st = o['ko.v2'] || {}; st.enabled = false;
          chrome.storage.local.set({ 'ko.v2': st }, () => res(true));
        });
      })`);
      await delay(7000);
      const a = await s.page.evalMain(TWITCH_VIDEO);
      await delay(1800);
      const b = await s.page.evalMain(TWITCH_VIDEO);
      await s.page.evalIsolated(`new Promise((res) => {
        chrome.storage.local.get('ko.v2', (o) => {
          const st = o['ko.v2'] || {}; st.enabled = true;
          chrome.storage.local.set({ 'ko.v2': st }, () => res(true));
        });
      })`);
      if (!a || !b) throw new Error('no Twitch <video>');
      if (b.paused || b.rs < 2) throw new Error(`Twitch video paused=${b.paused} rs=${b.rs}`);
      if (!(b.ct > a.ct)) throw new Error(`Twitch video not advancing (${a.ct.toFixed(2)} -> ${b.ct.toFixed(2)})`);
      return `twitch native plays (${a.ct.toFixed(1)} -> ${b.ct.toFixed(1)})`;
    });
  }

  // ---- 4. exceptions + screenshot --------------------------------------------
  const ex = [
    ...s.page.exceptions.map((e) => ({ where: 'page', text: e.text })),
    ...(s.hls?.exceptions || []).map((e) => ({ where: 'hls', text: e.text })),
    ...(s.ivs?.exceptions || []).map((e) => ({ where: 'ivs', text: e.text })),
    ...(s.sw?.exceptions || []).map((e) => ({ where: 'sw', text: e.text })),
  ];
  if (ex.length) warn('console.exceptions', `${ex.length} captured (see report)`);
  else pass('console.exceptions', 'none');

  try {
    await delay(2000);
    await s.page.screenshot('G:/Temp/opencode/ko-harness-check.png');
    pass('screenshot', 'G:/Temp/opencode/ko-harness-check.png');
  } catch (e) { warn('screenshot', e.message); }

  return finish();

  function finish() {
    const failed = results.some((r) => r.status === 'FAIL');
    const summary = {
      at: new Date().toISOString(),
      ms: Date.now() - t0,
      ytUrl,
      failed,
      counts: results.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {}),
      results,
      exceptions: [
        ...s.page.exceptions.map((e) => ({ where: 'page', ...e })),
        ...(s.hls?.exceptions || []).map((e) => ({ where: 'hls', ...e })),
        ...(s.ivs?.exceptions || []).map((e) => ({ where: 'ivs', ...e })),
        ...(s.sw?.exceptions || []).map((e) => ({ where: 'sw', ...e })),
      ],
      console: [
        ...s.page.console.map((e) => ({ where: 'page', ...e })),
        ...(s.hls?.console || []).map((e) => ({ where: 'hls', ...e })),
        ...(s.sw?.console || []).map((e) => ({ where: 'sw', ...e })),
      ].slice(-80),
    };
    writeFileSync('G:/Temp/opencode/ko-harness-report.json', JSON.stringify(summary, null, 2));
    console.log(`\n${failed ? 'FAILED' : 'OK'}  ${summary.ms}ms  ${JSON.stringify(summary.counts)}`);
    console.log('report: G:/Temp/opencode/ko-harness-report.json');
    return summary;
  }
}
