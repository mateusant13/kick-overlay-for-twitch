// ko-cdp.mjs — small dependency-free CDP client used by ko-harness.mjs.
// Keeps one browser connection, attaches to page / iframes / service worker,
// discovers the page's isolated content-script world, and offers the few
// primitives the overlay diagnostics need (eval, wait, click, screenshot).
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    // Callers that never send still must not crash the process on a bad port.
    this.ready.catch(() => {});
    this.ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        clearTimeout(timer);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) {
        for (const cb of this.handlers.get(m.method)) cb(m.params, m.sessionId);
      }
    };
  }

  send(method, params = {}, sessionId, timeout = 30000) {
    const id = ++this.id;
    return this.ready.then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timeout`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    }));
  }

  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

export async function connect(port = 9333) {
  // The browser ws URL includes a per-process UUID; always ask /json/version.
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = new CDP(v.webSocketDebuggerUrl);
  cdp.version = v;
  return cdp;
}

export class Session {
  constructor(cdp, targetId, sessionId, label) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.label = label;
    this.contexts = [];
    this.exceptions = [];
    this.console = [];
    this.network = [];
    cdp.on('Runtime.executionContextCreated', (p, s) => {
      if (s === sessionId) this.contexts.push(p.context);
    });
    cdp.on('Runtime.executionContextDestroyed', (p, s) => {
      if (s === sessionId) this.contexts = this.contexts.filter((c) => c.id !== p.executionContextId);
    });
    cdp.on('Runtime.exceptionThrown', (p, s) => {
      if (s === sessionId) this.exceptions.push({
        at: new Date().toISOString(),
        text: p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception',
      });
    });
    cdp.on('Runtime.consoleAPICalled', (p, s) => {
      if (s !== sessionId) return;
      if (!['error', 'warning', 'warn'].includes(p.type)) return;
      this.console.push({
        at: new Date().toISOString(),
        type: p.type,
        text: p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400),
      });
    });
    cdp.on('Network.requestWillBeSent', (p, s) => {
      if (s === sessionId) this.network.push({ kind: 'req', id: p.requestId, url: p.request.url, method: p.request.method, at: Date.now() });
    });
    cdp.on('Network.responseReceived', (p, s) => {
      if (s === sessionId) this.network.push({ kind: 'res', id: p.requestId, url: p.response.url, status: p.response.status, mime: p.response.mimeType, at: Date.now() });
    });
    cdp.on('Network.loadingFailed', (p, s) => {
      if (s === sessionId) this.network.push({ kind: 'fail', id: p.requestId, error: p.errorText, blocked: p.blockedReason || '', at: Date.now() });
    });
  }

  async enable({ network = false, page = false } = {}) {
    await this.cdp.send('Runtime.enable', {}, this.sessionId);
    if (page) {
      await this.cdp.send('Page.enable', {}, this.sessionId);
      try {
        const tree = await this.cdp.send('Page.getFrameTree', {}, this.sessionId);
        this.mainFrameId = tree.frameTree?.frame?.id || null;
      } catch { /* ignore */ }
    }
    if (network) await this.cdp.send('Network.enable', {}, this.sessionId);
    await delay(250);
    return this;
  }

  async refreshContexts() {
    this.contexts = [];
    try { await this.cdp.send('Runtime.disable', {}, this.sessionId); } catch { /* ignore */ }
    await this.cdp.send('Runtime.enable', {}, this.sessionId);
    await delay(250);
    return this.contexts;
  }

  mainContext() {
    const defaults = this.contexts.filter((c) => c.auxData && c.auxData.isDefault);
    return (this.mainFrameId && defaults.find((c) => c.auxData.frameId === this.mainFrameId)) || defaults[0];
  }

  // The top-frame isolated world is the content script. Iframe extension pages
  // have an extension origin too, but no auxData.isDefault (their default is
  // the extension main world); the caller uses evalRaw for those.
  isolatedContext() {
    const worlds = this.contexts.filter((c) =>
      (c.origin || '').startsWith('chrome-extension://') &&
      c.auxData && c.auxData.type === 'isolated'
    );
    return (this.mainFrameId && worlds.find((c) => c.auxData.frameId === this.mainFrameId)) || worlds[0];
  }

  async evalRaw(expression, { contextId, awaitPromise = true, timeout = 30000 } = {}) {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      contextId,
    }, this.sessionId, timeout);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const msg = d.exception?.description || d.text || 'eval exception';
      const err = new Error(String(msg).slice(0, 500));
      err.exception = d;
      throw err;
    }
    return r.result ? r.result.value : undefined;
  }

  evalMain(expression, opts = {}) {
    const c = this.mainContext();
    if (!c) throw new Error(`${this.label}: no main context`);
    return this.evalRaw(expression, { ...opts, contextId: c.id });
  }

  evalIsolated(expression, opts = {}) {
    const c = this.isolatedContext();
    if (!c) throw new Error(`${this.label}: no isolated content-script context`);
    return this.evalRaw(expression, { ...opts, contextId: c.id });
  }

  async waitFor(expression, predicate, { world = 'isolated', timeout = 20000, interval = 500, label = '' } = {}) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeout) {
      try {
        const value = world === 'main'
          ? await this.evalMain(expression)
          : await this.evalIsolated(expression);
        last = value;
        if (predicate(value)) return value;
      } catch (e) {
        last = { error: String(e.message || e).slice(0, 160) };
      }
      await delay(interval);
    }
    const err = new Error(`${label || expression}: timeout after ${timeout}ms (last=${JSON.stringify(last)?.slice(0, 300)})`);
    err.last = last;
    throw err;
  }

  async reload() {
    await this.cdp.send('Page.reload', { ignoreCache: false }, this.sessionId);
    await delay(2000);
    await this.refreshContexts();
    // Wait for the content script to come back (Twitch needs ~5-10s).
    const started = Date.now();
    while (Date.now() - started < 30000) {
      try {
        const ok = await this.evalIsolated('typeof KO !== "undefined" && !!KO');
        if (ok) return;
      } catch { /* contexts still replacing */ }
      await delay(500);
      await this.refreshContexts();
    }
    throw new Error('page reload: KO never injected');
  }

  async screenshot(file) {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.sessionId, 30000);
    if (!r.data) throw new Error('screenshot: no data');
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  async setViewport(width, height) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    }, this.sessionId);
    await delay(600);
  }

  async clearViewport() {
    try { await this.cdp.send('Emulation.clearDeviceMetricsOverride', {}, this.sessionId); } catch { /* ignore */ }
  }

  async hitTest(selector) {
    const expr = `(() => {
      const b = document.querySelector(${JSON.stringify(selector)});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const e = document.elementFromPoint(x, y);
      return {
        x, y, w: r.width, h: r.height,
        display: getComputedStyle(b).display,
        pointerEvents: getComputedStyle(b).pointerEvents,
        hit: e ? { tag: e.tagName, id: e.id, cls: String(e.className || '').slice(0, 90), text: String(e.textContent || '').slice(0, 40) } : null,
        isSelf: !!(e && (e === b || b.contains(e))),
      };
    })()`;
    return this.evalMain(expr);
  }

  async click(selector, { real = true, settle = 500 } = {}) {
    const hit = await this.hitTest(selector);
    if (!hit) throw new Error(`click: ${selector} not found`);
    if (!real) {
      await this.evalMain(`document.querySelector(${JSON.stringify(selector)})?.click(); true`);
      await delay(settle);
      return { hit, mode: 'synthetic' };
    }
    // Use integer-ish coordinates; CDP accepts floats but hit testing is pixel-based.
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y, button: 'none' }, this.sessionId);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 }, this.sessionId);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 }, this.sessionId);
    await delay(settle);
    return { hit, mode: 'real' };
  }

  async evalIframe(expression, { network = false } = {}) {
    if (network) await this.cdp.send('Network.enable', {}, this.sessionId);
    return this.evalRaw(expression, { contextId: this.mainContext()?.id });
  }
}

export async function findTargets(cdp, { pageRe = /twitch\.tv|youtube\.com/, wantSw = true } = {}) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && pageRe.test(t.url || ''));
  const hls = targetInfos.find((t) => t.type === 'iframe' && /player\.html\?m=hls/.test(t.url || ''));
  const ivs = targetInfos.find((t) => t.type === 'iframe' && /player\.html\?token=/.test(t.url || ''));
  const sw = wantSw ? targetInfos.find((t) => t.type === 'service_worker' && /background\.js/.test(t.url || '')) : null;
  return { targetInfos, page, hls, ivs, sw };
}

export async function attach(cdp, target, label) {
  if (!target) return null;
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  return new Session(cdp, target.targetId, sessionId, label).enable({ network: false });
}

export { delay };
