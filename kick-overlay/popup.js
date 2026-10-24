// Kick Overlay popup — toggle + per-channel Kick/YouTube mapping + live status.
'use strict';

const KEY = 'ko.v2';
const PROXY_KEY = 'ko.twitchProxy';
const $ = (id) => document.getElementById(id);

async function readProxy() {
  try {
    const o = await chrome.storage.local.get(PROXY_KEY);
    return o[PROXY_KEY] || {};
  } catch {
    return {};
  }
}

async function writeProxy(p) {
  try {
    await chrome.storage.local.set({ [PROXY_KEY]: p });
  } catch {
    /* ignore */
  }
}

async function readState() {
  try {
    const o = await chrome.storage.local.get(KEY);
    return o[KEY] || {};
  } catch {
    return {};
  }
}

async function writeState(s) {
  try {
    await chrome.storage.local.set({ [KEY]: s });
  } catch {
    /* storage busy — popup state is best-effort */
  }
}

function twitchSlugFromUrl(url) {
  if (!url) return null;
  const m = url.match(/twitch\.tv\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

async function kickStatus(slug) {
  // Same v2→v1 fallback and liveness rule as the content script (kickPlaybackUrl):
  // LIVE only when the livestream object exists with a playback_url (nested or
  // top-level). The top-level playback_url alone is NOT live — kick's v2 API
  // returns a stale one for OFFLINE channels (proven with nyro), and the popup
  // must not report "Kick: LIVE" while the content script shows the channel off.
  const enc = encodeURIComponent(slug);
  for (const url of [
    `https://kick.com/api/v2/channels/${enc}`,
    `https://kick.com/api/v1/channels/${enc}`,
  ]) {
    try {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) continue;
      const d = await r.json();
      const ls = d && d.livestream;
      if (ls) {
        if (ls.playback_url || d.playback_url) {
          return {
            live: true,
            viewers: d.viewer_count ?? null,
            title: (ls.session_title) || '',
          };
        }
        return { live: false };
      }
    } catch {
      /* try next */
    }
  }
  return { live: null };
}

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const slug = twitchSlugFromUrl(tab && tab.url);
  const st = await readState();

  // ---- Twitch proxy (HD, no SSAI) ----------------------------------------
  // Editable from any page: the proxy is a browser-level setting, not tied to
  // the current Twitch tab.
  const proxy = await readProxy();
  $('proxyOn').checked = !!proxy.enabled;
  $('proxyHost').value = proxy.host ? `${proxy.host}:${proxy.port || 8899}` : '';
  $('proxyUser').value = proxy.user || '';
  $('proxyPass').value = proxy.pass || '';
  if (proxy.enabled) $('proxyHint').textContent = 'Proxy ativo. Recarregue a Twitch se acabou de ativar.';

  async function saveProxy() {
    const raw = $('proxyHost').value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    let host = raw;
    let port = 8899;
    const m = raw.match(/^\[([^\]]+)\]:(\d+)$/) || raw.match(/^([^:]+):(\d+)$/);
    if (m) {
      host = m[1];
      port = Number(m[2]) || 8899;
    }
    const enabled = $('proxyOn').checked;
    if (enabled && !host) {
      $('proxyHint').textContent = 'Informe host:port do proxy.';
      return;
    }
    await writeProxy({
      enabled,
      host,
      port,
      user: $('proxyUser').value.trim(),
      pass: $('proxyPass').value,
    });
    $('proxyHint').textContent = enabled
      ? 'Proxy ativo — recarregue a Twitch para aplicar.'
      : 'Proxy desligado.';
  }
  $('proxySave').addEventListener('click', saveProxy);
  $('proxyOn').addEventListener('change', saveProxy);

  $('channel').textContent = slug ? `twitch.tv/${slug}` : 'Not on a Twitch channel';
  $('enabled').checked = st.enabled === undefined ? true : !!st.enabled;
  $('adblock').checked = st.adblock === undefined ? true : !!st.adblock;
  $('player').value = st.player === 'twitch' ? 'twitch' : st.player === 'youtube' ? 'youtube' : 'kick';
  // Popup is INERT off Twitch: no state writes, no player switches, no delete.
  const offTwitch = !slug;
  $('enabled').disabled = offTwitch;
  $('adblock').disabled = offTwitch;
  $('player').disabled = offTwitch;
  if (offTwitch) $('status').textContent = 'Abra uma página da Twitch para controlar o overlay.';
  const del = $('del');
  if (slug && tab && tab.id) {
    del.style.display = 'block';
    del.addEventListener('click', async () => {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'ko-delete-twitch' });
        $('status').textContent = 'Player da Twitch removido — recarregue a página para restaurar.';
      } catch {
        $('status').textContent = 'Recarregue a página da Twitch primeiro (extensão não injetada).';
      }
    });
  }
  const m = slug ? (st.mappings && st.mappings[slug]) : undefined;
  const kickSlug = typeof m === 'string' ? m : m ? m.kick || '' : '';
  const ytVal = m && typeof m === 'object' ? m.yt || '' : '';
  if (slug) $('kick').value = kickSlug;
  $('yt').value = ytVal;
  $('kick').disabled = !slug;
  $('yt').disabled = !slug;

  // 0.8.32: a true 1:1 player is the platform's own page. There is no stable
  // clone and the Kick embed exposes no control API, so the popup offers the
  // official page as an explicit escape hatch instead of faking its UI.
  const official = $('official');
  function officialTarget() {
    if (!slug) return null;
    const p = $('player').value;
    if (p === 'youtube') {
      let raw = ($('yt').value || '').trim();
      if (!raw && m && typeof m === 'object' && m.ytId) raw = m.ytId;
      if (!raw) return null;
      let href = raw;
      if (/^[0-9A-Za-z_-]{11}$/.test(raw)) href = `https://www.youtube.com/watch?v=${raw}`;
      else if (/^UC[0-9A-Za-z_-]{22}$/.test(raw)) href = `https://www.youtube.com/channel/${raw}/live`;
      else if (/^@[A-Za-z0-9._-]+$/.test(raw)) href = `https://www.youtube.com/${raw}/live`;
      else if (/^(?:www\.)?youtube\.com\//i.test(raw) || /^youtu\.be\//i.test(raw)) {
        href = `https://${raw.replace(/^https?:\/\//i, '')}`;
      } else if (!/^https?:\/\//i.test(raw)) href = `https://www.youtube.com/@${raw}/live`;
      return { href, label: 'Abrir no site oficial' };
    }
    if (p === 'twitch') {
      return { href: `https://www.twitch.tv/${encodeURIComponent(slug)}`, label: 'Abrir no site oficial' };
    }
    const kick = ($('kick').value || '').trim() || slug;
    return { href: `https://kick.com/${encodeURIComponent(kick)}`, label: 'Abrir no site oficial' };
  }
  function renderOfficial() {
    if (!slug) {
      official.style.display = 'none';
      return;
    }
    const t = officialTarget();
    if (!t) {
      official.style.display = 'none';
      return;
    }
    official.href = t.href;
    official.textContent = t.label;
    official.style.display = 'block';
  }
  renderOfficial();
  $('player').addEventListener('change', renderOfficial);
  $('kick').addEventListener('input', renderOfficial);
  $('yt').addEventListener('input', renderOfficial);

  if (slug && kickSlug) {
    const s = await kickStatus(kickSlug);
    if (s.live === true) {
      // session_title is set by the kick streamer — attacker-controlled;
      // build the status with text nodes, never innerHTML.
      const el = $('status');
      el.innerHTML = '';
      const b = document.createElement('b');
      b.className = 'ok';
      b.textContent = 'Kick: LIVE';
      el.appendChild(b);
      if (s.viewers) el.append(` · ${s.viewers} viewers`);
      if (s.title) el.append(` · ${s.title}`);
    } else if (s.live === false) {
      $('status').innerHTML = '<b class="off">Kick: offline</b>';
    } else {
      $('status').textContent = 'Kick: unreachable';
    }
  } else if (slug && ytVal) {
    $('status').textContent = 'YouTube: mapped (status shown on the page)';
  }

  // Storage writes hot-apply in the content script via storage.onChanged —
  // no page reload needed.
  $('enabled').addEventListener('change', async (e) => {
    const fresh = await readState();
    fresh.enabled = e.target.checked;
    await writeState(fresh);
  });

  $('adblock').addEventListener('change', async (e) => {
    const fresh = await readState();
    fresh.adblock = e.target.checked;
    await writeState(fresh);
  });

  $('player').addEventListener('change', async (e) => {
    const v = e.target.value;
    // Re-read immediately before writing: the popup-open st snapshot goes
    // stale the moment another tab or the overlay-side saveState() writes
    // (mute/progress), and writing the whole stale object would clobber that
    // back (P5) — and can manufacture a player === prev.player echo that the
    // content script's retry gate must then survive. Merge onto the freshest.
    const fresh = await readState();
    fresh.player = v === 'twitch' ? 'twitch' : v === 'youtube' ? 'youtube' : 'kick';
    // 0.8.6 pain-4: an explicit popup re-pick must read as retry intent even
    // when the value is unchanged since the last write (a same-value write
    // after a session-only yt->kick fallback must re-mint). fresh.playerAt
    // is the intent marker the content script keys on; nothing else (volume/
    // mapping echoes, the overlay's own saveState) ever stamps it. A user
    // who re-picks YouTube immediately — the natural reaction to a failed
    // hand-back — is no longer swallowed by a 30s backoff.
    fresh.playerAt = Date.now();
    await writeState(fresh);
    if (v === 'youtube' && !$('yt').value.trim()) {
      $('status').textContent = 'YouTube needs a channel: paste URL, @handle or UC… above.';
    } else {
      $('status').textContent = 'Applied — switch anytime from the player.';
    }
  });

  $('save').addEventListener('click', async () => {
    if (!slug) return;
    const kick = $('kick').value.trim().toLowerCase();
    const yt = $('yt').value.trim();
    // Re-read AFTER any pending write (the player select above, another tab's
    // saveState) — the popup-open `st` snapshot (which carries st.player) goes
    // stale the moment anything writes; mutating and writing it would clobber
    // the fresh player back AND manufacture the same-value echo the retry gate
    // exists to survive (0.8.6 pain-4 / P5). Mutate ONLY the mapping fields.
    const fresh = await readState();
    if (!fresh.mappings) fresh.mappings = {};
    const prev = fresh.mappings[slug];
    const base = prev && typeof prev === 'object' ? prev : {};
    if (kick || yt) {
      // Clearing a field must clear it (the old `kick || base.kick` kept a
      // stale mapping the user deleted); empty kick = default to the Twitch
      // slug, exactly like the content script's `m.kick || slug` fallback.
      const next = { ...base, kick: kick || slug, yt: yt || '' };
      // Resolve the YouTube handle/URL to its UC... id now, so the content
      // script never has to wait for a fetch when switching to YouTube.
      if (next.yt) {
        try {
          const r = await chrome.runtime.sendMessage({ type: 'ko-resolve-yt', value: next.yt });
          if (r && r.id) next.ytId = r.id;
          else delete next.ytId;
        } catch {
          delete next.ytId;
        }
      } else {
        delete next.ytId;
      }
      fresh.mappings[slug] = next;
    } else {
      delete fresh.mappings[slug];
    }
    await writeState(fresh);
    window.close();
  });
})();
