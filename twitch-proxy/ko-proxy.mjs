#!/usr/bin/env node
// ko-proxy.mjs - tiny HTTP CONNECT proxy for the Twitch ad-free playlist path.
//
// Why this exists: Twitch stitches SSAI ads into the HLS playlists at the edge,
// and the decision is made from the *egress IP/region* that requests the
// playlist. A proxy in a region where Twitch does not fill ads returns a clean
// HD playlist. The video segments are still fetched directly by the browser,
// so bandwidth through this proxy is only the playlist/usher/GQL traffic
// (a few MB per session, not the video).
//
// No dependencies. Node >= 18.
//
// Env:
//   KO_PROXY_HOST   bind address (default 0.0.0.0)
//   KO_PROXY_PORT   listen port  (default 8899)
//   KO_PROXY_AUTH   "user:pass" basic auth (optional; strongly recommended)
//   KO_PROXY_ALLOW  comma-separated client IP allowlist (optional, in addition
//                   to auth; useful when the proxy is firewalled by IP)
//   KO_PROXY_LOG    "0" to silence connection logs
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const HOST = process.env.KO_PROXY_HOST || '0.0.0.0';
const PORT = Number(process.env.KO_PROXY_PORT || 8899);
const AUTH = String(process.env.KO_PROXY_AUTH || '').trim();
const ALLOW = String(process.env.KO_PROXY_ALLOW || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const LOG = process.env.KO_PROXY_LOG !== '0';

const log = (...a) => {
  if (LOG) console.log(new Date().toISOString(), ...a);
};
const normIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

function ipAllowed(ip) {
  if (!ALLOW.length) return true;
  const v = normIp(ip);
  return ALLOW.includes(v) || ALLOW.includes(String(ip || ''));
}

function authOk(req) {
  if (!AUTH) return true;
  const raw = String(req.headers['proxy-authorization'] || '');
  const m = /^Basic\s+(.+)$/i.exec(raw);
  if (!m) return false;
  let given = '';
  try {
    given = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(AUTH);
  return a.length === b.length && timingSafeEqual(a, b);
}

function deny(socket, needAuth) {
  const status = needAuth ? '407 Proxy Authentication Required' : '403 Forbidden';
  const body = needAuth ? 'proxy authentication required' : 'forbidden';
  try {
    socket.write(
      `HTTP/1.1 ${status}\r\n` +
        (needAuth ? 'Proxy-Authenticate: Basic realm="ko-proxy"\r\n' : '') +
        'Content-Type: text/plain\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n\r\n' +
        body,
    );
  } catch {
    /* socket already gone */
  }
  socket.destroy();
}

const server = http.createServer((req, res) => {
  // Liveness probe (kept unauthenticated so a deploy script can check it).
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), auth: !!AUTH }));
    return;
  }
  const remote = req.socket.remoteAddress || '';
  if (!ipAllowed(remote)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  if (!authOk(req)) {
    res.writeHead(407, { 'proxy-authenticate': 'Basic realm="ko-proxy"', 'content-type': 'text/plain' });
    res.end('proxy authentication required');
    return;
  }
  // Absolute-URI HTTP forwarding (most Twitch traffic is HTTPS => CONNECT).
  let target;
  try {
    target = new URL(req.url || '');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad proxy request');
    return;
  }
  if (target.protocol !== 'http:') {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('https requires CONNECT');
    return;
  }
  const headers = { ...req.headers, host: target.host };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  const up = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    },
  );
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`upstream: ${e.message}`);
  });
  req.pipe(up);
});

server.on('connect', (req, clientSocket, head) => {
  const remote = normIp(clientSocket.remoteAddress);
  if (!ipAllowed(remote)) {
    deny(clientSocket, false);
    return;
  }
  if (!authOk(req)) {
    deny(clientSocket, true);
    return;
  }
  const [host, portRaw] = String(req.url || '').split(':');
  const port = Number(portRaw) || 443;
  if (!host || port < 1 || port > 65535) {
    deny(clientSocket, false);
    return;
  }
  log('CONNECT', `${host}:${port}`, remote);
  const upstream = net.connect({ host, port }, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: ko-proxy\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  // Keep idle keep-alive tunnels alive between playlist polls.
  upstream.setTimeout(120000, () => upstream.destroy());
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', (e) => {
    log('upstream-error', `${host}:${port}`, e.code || e.message);
    clientSocket.destroy();
  });
  clientSocket.on('error', () => upstream.destroy());
  clientSocket.on('close', () => upstream.destroy());
});

server.on('error', (e) => {
  console.error('proxy server error:', e.message);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  log(`ko-proxy listening on ${HOST}:${PORT}`, AUTH ? 'auth=on' : 'auth=OFF', ALLOW.length ? `allow=${ALLOW.join(',')}` : 'allow=any');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
