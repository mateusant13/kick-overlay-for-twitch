// ko-live-watch.mjs — captura e explica o que o dono ve numa aba de live da Twitch.
// Somente leitura: anexa na aba do perfil de debug (9222), nao clica, nao navega,
// nao recarrega. Serve para responder "aconteceu rewind/skip nesse pod?" com
// numeros, em vez de olhar log solto.
//
//   node _tools/ko-live-watch.mjs watch  [--tag=owner] [--every=500] [--port=9222]
//   node _tools/ko-live-watch.mjs state  [--tag=owner] [--port=9222]
//   node _tools/ko-live-watch.mjs report [--tag=owner] [--from=HH:MM:SS] [--to=HH:MM:SS]
//   node _tools/ko-live-watch.mjs stop   [--tag=owner]
//
// Arquivos (dir = KO_WATCH_DIR ou G:/Temp/opencode):
//   ko-live-<tag>.jsonl  stream de amostras, eventos do ko.adlog e erros da pagina
//   ko-live-<tag>.pid
//
// Metricas usadas no report:
//   gap      = buffered.end(ultimo) - currentTime. Em live, a borda so existe ate
//              onde ha segmento, entao gap ~= quanto o player esta atras da live.
//              (seekable.end em live devolve 2^30 e nao serve.)
//   VISIVEL  = o que o dono ve: o player do overlay quando #ko-adfix cobre a tela,
//              senao o <video> nativo da pagina.
//   SEEK     = variacao de currentTime maior que a variacao de tempo de parede.
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './ko-cdp.mjs';

const args = Object.fromEntries(process.argv.slice(3).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/);
  return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
}));
const cmd = process.argv[2] || 'state';
const TAG = String(args.tag || 'owner');
const PORT = Number(args.port || process.env.PORT || 9222);
const EVERY = Math.max(200, Number(args.every || 500));
const DIR = process.env.KO_WATCH_DIR || 'G:/Temp/opencode';
const JSONL = path.join(DIR, `ko-live-${TAG}.jsonl`);
const PID = path.join(DIR, `ko-live-${TAG}.pid`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmmss = (t) => {
  const d = new Date(t);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
const f1 = (n) => (Number.isFinite(n) ? String(Math.round(n * 10) / 10) : '?');

// ---------------------------------------------------------------- expressions
const PAGE_STATE = `(() => {
  const ov = document.getElementById('ko-adfix');
  const vids = [...document.querySelectorAll('video')].map((v) => {
    let be = 0, se = 0;
    try { if (v.buffered.length) be = v.buffered.end(v.buffered.length - 1); } catch {}
    try { if (v.seekable.length) se = v.seekable.end(v.seekable.length - 1); } catch {}
    const r = v.getBoundingClientRect();
    return {
      ct: +Number(v.currentTime || 0).toFixed(2), paused: !!v.paused, rs: v.readyState,
      muted: !!v.muted, vol: +Number(v.volume || 0).toFixed(2), err: v.error ? v.error.code : 0,
      be: +be.toFixed(2), gap: +(be - (v.currentTime || 0)).toFixed(2), se: se > 1e6 ? -1 : +se.toFixed(2),
      w: Math.round(r.width), h: Math.round(r.height),
      vis: getComputedStyle(v).visibility, op: getComputedStyle(v).opacity,
    };
  }).sort((a, b) => b.w * b.h - a.w * a.h);
  const st = window.__koTwitchAdblockStats || null;
  const ab = st && st.adBypass ? st.adBypass : null;
  return {
    url: location.href, vis: document.visibilityState,
    extId: document.documentElement.getAttribute('data-ko-ext-id'),
    ab: document.documentElement.getAttribute('data-ko-adblock'),
    ov: ov ? { op: getComputedStyle(ov).opacity, w: Math.round(ov.getBoundingClientRect().width), h: Math.round(ov.getBoundingClientRect().height) } : null,
    vids,
    stats: ab ? { pageId: st.pageId, starts: ab.starts, stops: ab.stops, standbyReady: ab.standbyReady, standbyHits: ab.standbyHits, last: ab.last && ab.last.type } : null,
  };
})()`;

const HLS_STATE = `(() => {
  const v = document.querySelector('video');
  if (!v) return null;
  let be = 0;
  try { if (v.buffered.length) be = v.buffered.end(v.buffered.length - 1); } catch {}
  return {
    ct: +Number(v.currentTime || 0).toFixed(2), paused: !!v.paused, rs: v.readyState,
    muted: !!v.muted, dur: Number.isFinite(v.duration) ? +v.duration.toFixed(1) : -1,
    be: +be.toFixed(2), gap: +(be - (v.currentTime || 0)).toFixed(2),
  };
})()`;

// ---------------------------------------------------------------- helpers
function writer() {
  fs.mkdirSync(DIR, { recursive: true });
  return (obj) => { try { fs.appendFileSync(JSONL, JSON.stringify(obj) + '\n'); } catch { /* ignore */ } };
}

async function attachPage(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const tw = targetInfos.filter((x) => x.type === 'page' && /^https?:\/\/(www\.)?twitch\.tv\//i.test(x.url || ''));
  if (!tw.length) return null;
  const chan = tw.filter((x) => {
    const p = new URL(x.url).pathname.split('/').filter(Boolean);
    return p.length && !/^(directory|search|videos|settings|subscriptions|friends|inventory|drops|wallet|p|popout)$/i.test(p[0]);
  });
  const page = chan[0] || tw[0];
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId).catch(() => {});
  return { targetId: page.targetId, sessionId, url: page.url };
}

async function attachHls(cdp, keep) {
  if (keep && keep.alive) {
    const r = await cdp.send('Runtime.evaluate', { expression: HLS_STATE, returnByValue: true }, keep.sessionId, 4000).catch(() => null);
    if (r && !r.exceptionDetails) return { sess: keep, value: r.result.value };
    keep.alive = false;
  }
  const { targetInfos } = await cdp.send('Target.getTargets');
  const t = targetInfos.find((x) => x.type === 'iframe' && /player\.html\?m=hls/.test(x.url || ''));
  if (!t) return { sess: null, value: null };
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const sess = { targetId: t.targetId, sessionId, alive: true };
  const r = await cdp.send('Runtime.evaluate', { expression: HLS_STATE, returnByValue: true }, sessionId, 4000).catch(() => null);
  return { sess, value: r ? r.result.value : null };
}

async function attachSw(cdp, extId, keep) {
  if (keep && keep.alive) return keep;
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find((x) => x.type === 'service_worker' && /background\.js/.test(x.url || '')
    && (!extId || String(x.url).includes(extId)));
  if (!sw) return null;
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  return { targetId: sw.targetId, sessionId, alive: true };
}

// ---------------------------------------------------------------- watch
async function watch() {
  const write = writer();
  fs.writeFileSync(PID, String(process.pid));
  const startedAt = Date.now();
  let cdp = null, page = null, hls = null, sw = null;
  let lastAdT = startedAt - 1;
  let tick = 0, lastBeat = 0;
  let best = null;

  console.log(`[watch] ${JSONL} every=${EVERY}ms port=${PORT} tag=${TAG}`);
  console.log('[watch] Ctrl+C para parar; "report" resume depois.');

  process.on('SIGINT', () => {
    try { fs.unlinkSync(PID); } catch {}
    if (best) console.log(`[watch] pico: em ${hhmmss(best.t)} ${best.where} gap=${f1(best.gap)}s`);
    console.log(`[watch] parado. amostras em ${JSONL}`);
    process.exit(0);
  });

  for (;;) {
    if (!cdp) {
      try { cdp = await connect(PORT); } catch { await sleep(2000); continue; }
      console.log(`[watch] conectado ${cdp.version.Browser}`);
    }
    tick++;
    if (!page) {
      try { page = await attachPage(cdp); } catch { page = null; }
      if (page) {
        write({ k: 'n', t: Date.now(), url: page.url });
        console.log(`[watch] aba ${page.url}`);
      }
    }

    if (page) {
      const r = await cdp.send('Runtime.evaluate', { expression: PAGE_STATE, returnByValue: true }, page.sessionId, 5000).catch(() => null);
      if (!r || r.exceptionDetails) {
        page = null; // navegou/fechou: reata no proximo tick
      } else {
        const s = r.result.value;
        const v = (s.vids || [])[0] || null;
        const ovOp = s.ov ? parseFloat(s.ov.op) : null;
        const covering = ovOp !== null && ovOp >= 0.5;
        const h = await attachHls(cdp, hls);
        hls = h.sess;
        const t = Date.now();
        const rec = {
          k: 's', t, wall: hhmmss(t), url: s.url, vis: s.vis, ab: s.ab,
          ov: s.ov ? { op: ovOp, w: s.ov.w, h: s.ov.h } : null,
          cover: covering,
          v: v ? { ct: v.ct, paused: v.paused, rs: v.rs, muted: v.muted, gap: v.gap, be: v.be, err: v.err } : null,
          hls: h.value || null,
          st: s.stats || null,
          nv: (s.vids || []).length,
        };
        write(rec);

        // pico de "atras da borda" na superficie visivel: nativo sem overlay por cima.
        if (!covering && v && v.gap > 2 && (!best || v.gap > best.gap)) {
          best = { t, gap: v.gap, where: 'nativo visivel' };
        }

        if (t - lastBeat > 5000) {
          lastBeat = t;
          const seen = covering ? `overlay op=${ovOp} ` + (h.value ? `ov.ct=${f1(h.value.ct)} ov.gap=${f1(h.value.gap)}` : 'ov=sem iframe') : `nativo ct=${f1(v && v.ct)} gap=${f1(v && v.gap)}s`;
          console.log(`[watch] ${hhmmss(t)} ${seen} pod=${s.stats ? s.stats.last || '-' : 'n/a'}`);
        }

        if (tick % 2 === 0) {
          if (!sw || !sw.alive) sw = await attachSw(cdp, s.extId, sw).catch(() => null);
          if (sw) {
            const log = await cdp.send('Runtime.evaluate', {
              expression: `chrome.storage.local.get('ko.adlog').then((o) => JSON.stringify(o['ko.adlog'] || []))`,
              returnByValue: true, awaitPromise: true,
            }, sw.sessionId, 6000).catch(() => null);
            if (log && log.result && log.result.value) {
              let entries = [];
              try { entries = JSON.parse(log.result.value); } catch {}
              for (const e of entries) {
                if (!(e.t > lastAdT)) continue;
                lastAdT = e.t;
                write({ k: 'a', t: e.t, wall: hhmmss(e.t), ev: e.ev, d: e.d || {} });
              }
            } else if (log === null) {
              sw.alive = false;
            }
          }
        }
      }
    }
    await sleep(EVERY);
  }
}

// ---------------------------------------------------------------- state
async function state() {
  const cdp = await connect(PORT);
  const s = { port: PORT, browser: cdp.version.Browser, at: hhmmss(Date.now()) };
  const page = await attachPage(cdp).catch(() => null);
  if (!page) { console.log(JSON.stringify({ ...s, page: null, note: 'nenhuma aba twitch.tv' }, null, 1)); cdp.close(); return; }
  const r = await cdp.send('Runtime.evaluate', { expression: PAGE_STATE, returnByValue: true }, page.sessionId).catch(() => null);
  s.page = r ? r.result.value : null;
  const h = await attachHls(cdp, null).catch(() => ({ value: null }));
  s.hls = h.value;
  if (s.page && s.page.extId) {
    const sw = await attachSw(cdp, s.page.extId, null).catch(() => null);
    if (sw) {
      const ver = await cdp.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().version', returnByValue: true }, sw.sessionId).catch(() => null);
      s.extVersion = ver && ver.result ? ver.result.value : null;
      const log = await cdp.send('Runtime.evaluate', {
        expression: `chrome.storage.local.get('ko.adlog').then((o) => JSON.stringify((o['ko.adlog'] || []).slice(-12)))`,
        returnByValue: true, awaitPromise: true,
      }, sw.sessionId).catch(() => null);
      if (log && log.result && log.result.value) {
        try { s.adlogTail = JSON.parse(log.result.value); } catch {}
      }
    }
  }
  console.log(JSON.stringify(s, null, 1));
  cdp.close();
}

// ---------------------------------------------------------------- report
function load() {
  if (!fs.existsSync(JSONL)) throw new Error(`sem captura em ${JSONL}`);
  return fs.readFileSync(JSONL, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function report() {
  const all = load();
  const from = args.from ? String(args.from) : null;
  const to = args.to ? String(args.to) : null;
  const inWin = (wall) => (!from || wall >= from) && (!to || wall <= to);
  const recs = all.filter((r) => inWin(r.wall || hhmmss(r.t)));
  const samples = recs.filter((r) => r.k === 's');
  const events = recs.filter((r) => r.k === 'a');
  if (!samples.length) { console.log('nenhuma amostra na janela'); return; }

  const span = (samples[samples.length - 1].t - samples[0].t) / 1000;
  console.log(`== captura ${TAG} ==`);
  console.log(`${hhmmss(samples[0].t)} .. ${hhmmss(samples[samples.length - 1].t)}  amostras=${samples.length} (${((span * 1000) / samples.length).toFixed(0)}ms)  eventos=${events.length}`);

  // ---- linha do tempo condensada
  console.log('\n-- linha do tempo --');
  const merged = [...samples.map((r) => ({ r, t: r.t, kind: 's' })), ...events.map((r) => ({ r, t: r.t, kind: 'a' }))].sort((a, b) => a.t - b.t);
  let prev = null, lastPrint = 0;
  for (const it of merged) {
    if (it.kind === 'a') {
      const d = it.r.d || {};
      const bits = ['step', 'type', 'reason', 'tag', 'ct', 'rs', 'paused', 'pos']
        .filter((k) => d[k] !== undefined && d[k] !== null && d[k] !== '').map((k) => `${k}=${d[k]}`).join(' ');
      console.log(`${it.r.wall}  adlog  ${it.r.ev}${bits ? ' ' + bits : ''}`);
      continue;
    }
    const s = it.r, v = s.v, h = s.hls;
    const vis = s.cover ? 'OVERLAY' : 'nativo ';
    let why = [];
    if (prev) {
      const dwt = (s.t - prev.t) / 1000;
      if (v && prev.v) {
        const dct = v.ct - prev.v.ct;
        if (dct - dwt > 1.5) why.push(`SEEK +${f1(dct)}s`);
        else if (dct - dwt < -1.5) why.push(`REWIND ${f1(dct)}s`);
        if (v.paused !== prev.v.paused) why.push(v.paused ? 'PAUSE' : 'PLAY');
        if (v.rs !== prev.v.rs) why.push(`rs ${prev.v.rs}->${v.rs}`);
        if (!v.paused && dct < 0.05 && dwt > 0.4) why.push('FREEZE');
      }
      if (s.cover !== prev.cover) why.push(s.cover ? 'overlay aparece' : 'overlay sai');
      if (s.url !== prev.url) why.push(`url ${String(s.url).replace('https://www.twitch.tv/', '')}`);
      const g = v && v.gap;
      const pg = prev.v && prev.v.gap;
      if (g !== undefined && pg !== undefined && Math.abs(g - pg) > 2) why.push(`gap ${f1(pg)}->${f1(g)}`);
      if (!why.length && s.t - lastPrint < 5000) { prev = s; continue; }
    }
    lastPrint = s.t;
    const ov = h ? `ov[ct=${f1(h.ct)} rs=${h.rs}${h.paused ? ' paused' : ''} gap=${f1(h.gap)}]` : 'ov[-]';
    const nv = v ? `nat[ct=${f1(v.ct)} rs=${v.rs}${v.paused ? ' paused' : ''} gap=${f1(v.gap)}${v.muted ? ' mute' : ''}]` : 'nat[-]';
    console.log(`${s.wall}  ${vis} ab=${s.ab} ${nv} ${ov}${why.length ? '  << ' + why.join(', ') : ''}`);
    prev = s;
  }

  // ---- pods
  const pods = [];
  let cur = null;
  for (const e of events) {
    const type = e.d && e.d.type;
    if (e.ev === 'bypass-msg' && (type === 'ad-hold' || type === 'ad-start')) {
      if (!cur) cur = { start: e.t, startType: type, end: null, evs: [e] };
      else cur.evs.push(e);
    } else if (e.ev === 'bypass-msg' && type === 'ad-end') {
      if (cur) { cur.end = e.t; cur.evs.push(e); pods.push(cur); cur = null; }
    } else if (cur) cur.evs.push(e);
  }
  if (cur) pods.push(cur);

  console.log('\n-- pods --');
  if (!pods.length) console.log('nenhum pod de anuncio na janela');
  for (const [i, p] of pods.entries()) {
    const t0 = p.start;
    let t1 = p.end;
    let inferredEnd = false;
    if (!t1) {
      // pod sem ad-end: a retomada real e a primeira amostra tocando e com imagem.
      const r = samples.find((s) => s.t > p.start + 2000 && s.v && s.v.rs >= 3 && !s.v.paused);
      if (r) { t1 = r.t; inferredEnd = true; } else t1 = p.start + 60000;
    }
    const w = samples.filter((s) => s.t >= t0 - 3000 && s.t <= t1 + 20000);
    const before = w.filter((s) => s.t < t0 && s.v).pop();
    const during = w.filter((s) => s.t >= t0 && s.t <= t1);
    const after = w.filter((s) => s.t >= t1);
    const frozen = during.filter((s) => s.v && (s.v.paused || s.v.rs < 3));
    const firstFrame = after.find((s) => s.v && s.v.rs >= 3 && !s.v.paused);
    const firstEdge = after.find((s) => s.v && s.v.rs >= 3 && !s.v.paused && s.v.gap <= 3);
    const endOk = firstEdge || (after.length ? after[after.length - 1] : null);
    const exposure = after.filter((s) => endOk && s.t <= endOk.t && s.v && !s.cover);
    const staleMs = firstEdge ? firstEdge.t - t1 : (after.length ? after[after.length - 1].t - t1 : 0);
    const staleSamples = exposure.filter((s) => s.v.gap > 2);
    const maxGap = exposure.reduce((m, s) => Math.max(m, s.v.gap), 0);
    const seeks = [];
    for (let k = 1; k < after.length; k++) {
      const a = after[k - 1], b = after[k];
      if (!a.v || !b.v) continue;
      const dwt = (b.t - a.t) / 1000, dct = b.v.ct - a.v.ct;
      if (Math.abs(dct - dwt) > 1.5 && seeks.length < 6) seeks.push({ at: b.wall, d: dct, dwt });
    }
    console.log(`\npod ${i + 1}: ${hhmmss(t0)}${p.end ? ' -> ' + hhmmss(p.end) : ` (SEM ad-end${inferredEnd ? ', retomada inferida em ' + hhmmss(t1) : ''})`}  ${p.end ? ((p.end - t0) / 1000).toFixed(1) + 's' : ((t1 - t0) / 1000).toFixed(1) + 's'}`);
    if (p.startType) console.log(`  inicio: ${p.startType}`);
    console.log(`  antes:      ct=${before ? f1(before.v.ct) : '?'} gap=${before ? f1(before.v.gap) : '?'}s ${before && before.cover ? '(overlay cobrindo)' : '(nativo)'}`);
    if (frozen.length) console.log(`  congelado:  ${frozen.length} amostras, ${((frozen[frozen.length - 1].t - frozen[0].t) / 1000).toFixed(1)}s, ct=${f1(frozen[0].v.ct)}`);
    if (!p.end) console.log('  AVISO: sem ad-end no ko.adlog; o caminho de handoff/catch-up nao rodou');
    const seekFwd = seeks.filter((s) => s.d > 0).reduce((a, s) => a + s.d, 0);
    const seekBack = seeks.filter((s) => s.d < 0).reduce((a, s) => a + s.d, 0);
    if (seeks.length) console.log(`  seeks:      ${seeks.map((s) => `${s.at} ${s.d > 0 ? '+' : ''}${f1(s.d)}s`).join(' | ')}`);
    if (firstFrame) console.log(`  imagem:     volta em ${firstFrame.wall} (${((firstFrame.t - t1) / 1000).toFixed(2)}s apos ad-end)`);
    console.log(`  borda:      ${firstEdge ? `alcancada em ${firstEdge.wall} (${((firstEdge.t - t1) / 1000).toFixed(2)}s)` : 'NAO alcancada na janela (ficou atras da live)'}`);
    console.log(`  exposto:    ${staleMs}ms ate a imagem boa; ${staleSamples.length} amostras com nativo visivel atras da borda (pico gap ${f1(maxGap)}s)`);
    console.log(`  veredito:   ${[
      p.end ? 'ad-end ok' : 'SEM ad-end',
      seekFwd > 3 ? `pulou +${f1(seekFwd)}s` : null,
      seekBack < -1.5 ? `voltou ${f1(seekBack)}s` : null,
      maxGap > 3 ? `mostrou conteudo ${f1(maxGap)}s atras da borda por ${staleMs}ms` : null,
      !p.end && frozen.length ? 'native parado sem catch-up' : null,
    ].filter(Boolean).join('; ')}`);
  }

  // ---- maior atraso visivel no nativo (sem overlay)
  const nat = samples.filter((s) => s.v && !s.cover);
  if (nat.length) {
    const worst = nat.reduce((m, s) => (s.v.gap > (m ? m.v.gap : -1) ? s : m), null);
    console.log(`\nmaior gap do nativo visivel: ${f1(worst.v.gap)}s em ${worst.wall}`);
    const spans = [];
    let run = null;
    for (const s of samples) {
      const g = s.v && !s.cover ? s.v.gap : 0;
      if (g > 3) { if (!run) run = { from: s.t, to: s.t, max: g, at: s.wall }; else { run.to = s.t; if (g > run.max) { run.max = g; run.at = s.wall; } } }
      else if (run) { spans.push(run); run = null; }
    }
    if (run) spans.push(run);
    if (spans.length) {
      console.log('janelas com nativo visivel atras da borda (>3s):');
      for (const s of spans) console.log(`  ${hhmmss(s.from)} .. ${hhmmss(s.to)}  ${((s.to - s.from) / 1000).toFixed(1)}s  pico ${f1(s.max)}s em ${s.at}`);
    }
  }
}

// ---------------------------------------------------------------- stop
function stop() {
  if (!fs.existsSync(PID)) { console.log(`sem pid em ${PID}`); return; }
  const pid = Number(fs.readFileSync(PID, 'utf8').trim());
  try { process.kill(pid); console.log(`matei ${pid}`); } catch (e) { console.log(`nao consegui matar ${pid}: ${e.message}`); }
  try { fs.unlinkSync(PID); } catch {}
}

if (cmd === 'watch') await watch();
else if (cmd === 'state') await state();
else if (cmd === 'report') report();
else if (cmd === 'stop') stop();
else console.log('uso: watch | state | report | stop  [--tag=owner] [--every=500] [--port=9222]');
