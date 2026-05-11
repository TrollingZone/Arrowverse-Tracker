// Tiny zero-framework static server for the Arrowverse Tracker.
//
// Features:
//   - Binds to 0.0.0.0 so your phone on the same Wi-Fi can reach it.
//   - Prints all LAN URLs and a scannable QR code in the terminal.
//   - Optional HTTPS with a locally-generated self-signed cert
//     (needed for the PWA install prompt to appear on your phone).
//
// Usage:
//   node scripts/serve.js                 # HTTP on :8080
//   node scripts/serve.js --https         # HTTPS on :8443 (self-signed)
//   node scripts/serve.js --port 5000
//
// Flags:
//   --https         Enable HTTPS with a self-signed cert.
//   --port <n>      Override the port.
//   --host <ip>     Bind to a specific interface (default 0.0.0.0).

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PROGRESS_PATH = path.join(ROOT, 'data', 'progress.json');
const HISTORY_LIMIT = 1000;

// ---- progress store ---------------------------------------------------
// Single-user store persisted as JSON on disk. Writes are serialized
// through a tiny queue so concurrent requests from laptop + phone can't
// clobber each other.

function emptyStore() {
  return { watched: [], history: [], updatedAt: null, version: 1 };
}

function loadStore() {
  try {
    if (!fs.existsSync(PROGRESS_PATH)) return emptyStore();
    const raw = fs.readFileSync(PROGRESS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    parsed.watched = Array.isArray(parsed.watched) ? parsed.watched : [];
    parsed.history = Array.isArray(parsed.history) ? parsed.history : [];
    parsed.version = parsed.version || 1;
    return parsed;
  } catch (e) {
    console.warn('Could not read progress.json, starting fresh:', e.message);
    return emptyStore();
  }
}

let store = loadStore();
let writeChain = Promise.resolve();

function persist() {
  const snapshot = JSON.stringify(store);
  writeChain = writeChain.then(
    () =>
      new Promise((resolve) => {
        fs.mkdir(path.dirname(PROGRESS_PATH), { recursive: true }, () => {
          fs.writeFile(PROGRESS_PATH, snapshot, (err) => {
            if (err) console.warn('Failed to write progress.json:', err.message);
            resolve();
          });
        });
      })
  );
  return writeChain;
}

function recordHistory(entry) {
  store.history.push(entry);
  if (store.history.length > HISTORY_LIMIT) {
    store.history.splice(0, store.history.length - HISTORY_LIMIT);
  }
}

function toggle(id, watched, meta = {}) {
  const set = new Set(store.watched);
  const was = set.has(id);
  if (watched && !was) {
    set.add(id);
    recordHistory({ ts: new Date().toISOString(), id, action: 'watched', device: meta.device || null });
  } else if (!watched && was) {
    set.delete(id);
    recordHistory({ ts: new Date().toISOString(), id, action: 'unwatched', device: meta.device || null });
  } else {
    return store;
  }
  store.watched = [...set].sort((a, b) => a - b);
  store.version += 1;
  store.updatedAt = new Date().toISOString();
  persist();
  return store;
}

function replaceAll(watchedIds, meta = {}) {
  const normalized = [...new Set((watchedIds || []).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  store.watched = normalized;
  store.version += 1;
  store.updatedAt = new Date().toISOString();
  recordHistory({
    ts: store.updatedAt,
    id: null,
    action: 'bulk-replace',
    count: normalized.length,
    device: meta.device || null,
  });
  persist();
  return store;
}

function resetAll(meta = {}) {
  store.watched = [];
  store.history.push({
    ts: new Date().toISOString(),
    id: null,
    action: 'reset',
    device: meta.device || null,
  });
  store.version += 1;
  store.updatedAt = new Date().toISOString();
  persist();
  return store;
}

// ---- args -------------------------------------------------------------
const args = process.argv.slice(2);
const useHttps = args.includes('--https');
const portIdx = args.indexOf('--port');
const hostIdx = args.indexOf('--host');
const port = portIdx !== -1 ? Number(args[portIdx + 1]) : (useHttps ? 8443 : 8080);
const host = hostIdx !== -1 ? args[hostIdx + 1] : '0.0.0.0';

// ---- mime + helpers ---------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
};

function safeResolve(urlPath) {
  // Strip query string, decode, and prevent directory traversal.
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const resolved = path.normalize(path.join(ROOT, clean));
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body) res.end(body);
  else res.end();
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(body);
}

function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  // CORS preflight.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    });
    return res.end();
  }

  const route = url.pathname;

  if (route === '/api/progress' && req.method === 'GET') {
    return sendJson(res, 200, store);
  }

  if (route === '/api/progress' && req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const updated = replaceAll(body.watched, { device: body.device });
      return sendJson(res, 200, updated);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (route === '/api/progress/toggle' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!Number.isInteger(body.id)) {
        return sendJson(res, 400, { error: 'id must be an integer' });
      }
      const watched = body.watched !== false;
      const updated = toggle(body.id, watched, { device: body.device });
      return sendJson(res, 200, updated);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (route === '/api/progress' && req.method === 'DELETE') {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const updated = resetAll({ device: body && body.device });
      return sendJson(res, 200, updated);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (route === '/api/history' && req.method === 'GET') {
    return sendJson(res, 200, { history: store.history });
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url).catch((err) => {
      console.error('API error:', err);
      sendJson(res, 500, { error: 'Internal error' });
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'content-type': 'text/plain' }, 'Method Not Allowed');
  }
  let filePath = safeResolve(req.url);
  if (!filePath) return send(res, 400, { 'content-type': 'text/plain' }, 'Bad path');

  fs.stat(filePath, (err, stat) => {
    if (err || !stat) {
      return send(res, 404, { 'content-type': 'text/plain' }, 'Not found');
    }
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) return send(res, 404, { 'content-type': 'text/plain' }, 'Not found');
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      send(res, 200, {
        'content-type': type,
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      }, req.method === 'HEAD' ? undefined : data);
    });
  });
}

// ---- certificate for --https -----------------------------------------
function loadOrCreateCert() {
  const certDir = path.join(ROOT, '.cert');
  const keyPath = path.join(certDir, 'key.pem');
  const crtPath = path.join(certDir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(crtPath) };
  }

  let selfsigned;
  try {
    selfsigned = require('selfsigned');
  } catch {
    console.error('\nMissing dependency "selfsigned". Install once with:\n  npm install\n');
    process.exit(1);
  }

  console.log('Generating a local self-signed certificate (first run only)...');
  const attrs = [{ name: 'commonName', value: 'arrowverse-tracker.local' }];
  const ips = collectIPs();
  const altNames = [
    { type: 2, value: 'localhost' },          // DNS
    ...ips.map((ip) => ({ type: 7, ip })),   // IP
  ];
  const pems = selfsigned.generate(attrs, {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(crtPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

// ---- network utilities -----------------------------------------------
function collectIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

// ---- boot -------------------------------------------------------------
if (!fs.existsSync(path.join(ROOT, 'data', 'episodes.json'))) {
  console.warn('\nWARNING: data/episodes.json is missing.');
  console.warn('Generate it with:  npm run build-data\n');
}

const server = useHttps ? https.createServer(loadOrCreateCert(), handler) : http.createServer(handler);

server.listen(port, host, () => {
  const scheme = useHttps ? 'https' : 'http';
  const ips = collectIPs();
  const primary = ips[0];
  const phoneUrl = primary ? `${scheme}://${primary}:${port}` : null;

  const line = '─'.repeat(54);
  console.log('\n' + line);
  console.log('  Arrowverse Tracker is live locally');
  console.log(line);
  console.log(`  Local     : ${scheme}://localhost:${port}`);
  for (const ip of ips) console.log(`  LAN       : ${scheme}://${ip}:${port}`);
  if (useHttps) {
    console.log('\n  HTTPS uses a self-signed cert. On first visit your');
    console.log('  phone will warn you - tap "Advanced" > "Proceed".');
    console.log('  Installing as a PWA requires https, so this is the one.');
  } else {
    console.log('\n  For PWA install on your phone, use:  npm run start:https');
  }
  console.log(line);

  if (phoneUrl) {
    try {
      const qrcode = require('qrcode-terminal');
      console.log(`\n  Scan from your phone (${phoneUrl}):\n`);
      qrcode.generate(phoneUrl, { small: true });
    } catch {
      console.log('\n  Install the optional QR dep for a scannable code:');
      console.log('    npm install\n');
      console.log(`  Or just type this URL on your phone: ${phoneUrl}\n`);
    }
  } else {
    console.log('\n  No external network interface found.');
    console.log('  Connect your computer to Wi-Fi and relaunch.\n');
  }
  console.log('  Stop with Ctrl+C.\n');
});

process.on('SIGINT', () => {
  console.log('\nShutting down.');
  server.close(() => process.exit(0));
});
