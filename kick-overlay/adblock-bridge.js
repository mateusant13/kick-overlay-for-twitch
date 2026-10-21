'use strict';
// Mirrors the persisted adblock toggle into a DOM attribute the MAIN-world
// script can read. MAIN-world content scripts cannot use chrome.storage, so
// this tiny ISOLATED bridge is the only channel. Default is ON.
// Wrapped in an IIFE: content scripts share the isolated world's lexical
// scope, and content.js also declares `KEY`.
(() => {
  const KEY = 'ko.v2';
  const apply = (state) => {
    const on = !state || state.adblock !== false;
    const root = document.documentElement;
    if (!root) {
      document.addEventListener('DOMContentLoaded', () => apply(state), { once: true });
      return;
    }
    try {
      root.setAttribute('data-ko-adblock', on ? '1' : '0');
      // MAIN-world ad code needs the extension origin for the clean-stream
      // player iframe, and cannot call chrome.runtime.getURL itself.
      root.setAttribute('data-ko-ext-id', chrome.runtime.id);
    } catch {
      /* document may be tearing down */
    }
  };

  try {
    chrome.storage.local.get(KEY, (o) => {
      void chrome.runtime.lastError;
      apply(o && o[KEY]);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) apply(changes[KEY].newValue);
    });
  } catch {
    apply(null); // storage unavailable — keep the default ON
  }
})();
