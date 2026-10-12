// user/index.js - Sovereign Identity Component
// Manages user accounts with device collision prevention and recovery links.

import { createServer } from 'node:http';
import { readFile, writeFile, appendFile, mkdir, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { parse, DataFactory, expandIRI, DEFAULT_CONTEXT, updateValue } from '../public/mdld-parse.js';

const COMPONENT_DIR = process.env.COMPONENT_DIR;
const COMPONENT_NAME = process.env.COMPONENT_NAME || 'user';
const SECRET = process.env.AUTH_SECRET || 'forest-auth-secret';
const FOREST_CORE_PORT = process.env.FOREST_CORE_PORT || 3000;

// Device-user state file at forest root (gitignored, volatile)
const ROOT = join(COMPONENT_DIR, '..');
const USERS_STATE_FILE = join(ROOT, 'users.json');

const PREFIX = 'https://forest.defucc.me/user/';
const CONTEXT = { ...DEFAULT_CONTEXT, user: PREFIX, xsd: 'http://www.w3.org/2001/XMLSchema#' };

const { namedNode } = DataFactory;
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

const P = {
  hasDevice: expandIRI('user:hasDevice', CONTEXT),
  hadInitialDevice: expandIRI('user:hadInitialDevice', CONTEXT),
  createdAt: expandIRI('user:createdAt', CONTEXT),
  browser: expandIRI('user:browser', CONTEXT),
  os: expandIRI('user:os', CONTEXT),
};

const PROFILES_DIR = join(COMPONENT_DIR, 'profiles');
const userPath = (id) => join(PROFILES_DIR, `${id}.md`);

// ─── Device Map with Atomic File Sync ──────────────────────────────────────
const deviceMap = new Map();

async function syncStateFile() {
  const data = Object.fromEntries(deviceMap);
  const content = JSON.stringify(data, null, 2);
  const tmpPath = USERS_STATE_FILE + '.tmp';

  try {
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, USERS_STATE_FILE);
  } catch (err) {
    console.error('[user] Failed to sync state file:', err.message);
  }
}

async function rebuildDeviceMap() {
  deviceMap.clear();
  if (!existsSync(PROFILES_DIR)) return;

  const entries = await readdir(PROFILES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
    const userId = entry.name.replace('.md', '');
    try {
      const { quads } = parse({ text: await readFile(join(PROFILES_DIR, entry.name), 'utf8'), context: CONTEXT });
      const userNode = namedNode(expandIRI(`user:account/${userId}`, CONTEXT));
      for (const q of quads) {
        if (q.subject.equals(userNode) && q.predicate.value === P.hasDevice) {
          const deviceId = q.object.value.split('/').pop();
          if (deviceMap.has(deviceId)) {
            console.warn(`[user] ⚠️ Device collision: ${deviceId.slice(0, 8)} claimed by both ${deviceMap.get(deviceId)} and ${userId}`);
          }
          deviceMap.set(deviceId, userId);
        }
      }
    } catch (err) {
      console.error(`[user] Failed to parse ${entry.name}:`, err.message);
    }
  }

  // Sync to state file after rebuild
  await syncStateFile();
  console.log(`[user] 🗺️ Rebuilt device map: ${deviceMap.size} devices`);
}

// ─── User-Agent Parsing ────────────────────────────────────────────────────
function parseUserAgent(ua) {
  if (!ua) return { browser: 'Unknown', os: 'Unknown' };
  let browser = 'Unknown';
  if (ua.includes('Firefox/')) browser = 'Firefox';
  else if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome/')) browser = 'Chrome';
  else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';
  else if (ua.includes('OPR/') || ua.includes('Opera')) browser = 'Opera';

  let os = 'Unknown';
  if (ua.includes('Windows NT 10')) os = 'Windows 10/11';
  else if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS X')) os = 'macOS';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('Linux')) os = 'Linux';

  return { browser, os };
}

// ─── MD-LD Helpers ──────────────────────────────────────────────────────────
function md(s, ...v) { return String.raw({ raw: s }, ...v) }

async function loadUserIndex(userId) {
  try { return parse({ text: await readFile(userPath(userId), 'utf8'), context: CONTEXT }); }
  catch { return null; }
}

function getUserProfile(quads, userId) {
  const userNode = namedNode(expandIRI(`user:account/${userId}`, CONTEXT));
  const getProp = (pred) => quads.find(q => q.subject.equals(userNode) && q.predicate.value === pred)?.object.value;
  return {
    id: userId,
    label: quads.find(q => q.subject.equals(userNode) && q.predicate.value === RDFS_LABEL)?.object.value || 'Anonymous',
    createdAt: getProp(P.createdAt),
  };
}

function getUserDevices(quads, userId) {
  const userNode = namedNode(expandIRI(`user:account/${userId}`, CONTEXT));
  const deviceNodes = quads.filter(q => q.subject.equals(userNode) && q.predicate.value === P.hasDevice).map(q => q.object);
  return deviceNodes.map(dNode => ({
    id: dNode.value.split('/').pop(),
    isInitial: quads.some(q => q.subject.equals(userNode) && q.predicate.value === P.hadInitialDevice && q.object.equals(dNode)),
    browser: quads.find(q => q.subject.equals(dNode) && q.predicate.value === P.browser)?.object.value || 'Unknown',
    os: quads.find(q => q.subject.equals(dNode) && q.predicate.value === P.os)?.object.value || 'Unknown',
  }));
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────
const rateLimits = new Map();
const RATE_WINDOW_MS = 60000;
const RATE_MAX_POST = 30;

function checkRateLimit(key, max) {
  const now = Date.now();
  let entry = rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimits.set(key, entry);
  }
  entry.count++;
  return entry.count <= max;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) if (now > entry.resetAt) rateLimits.delete(key);
}, RATE_WINDOW_MS).unref();

// ─── Token Logic ─────────────────────────────────────────────────────────────
function createRecoveryToken(userId, ttlDays) {
  const exp = Date.now() + (ttlDays * 24 * 60 * 60 * 1000);
  const sig = crypto.createHmac('sha256', SECRET).update(`recover.${userId}.${exp}`).digest('hex').slice(0, 16);
  return `${userId}.${exp}.${sig}`;
}

function verifyRecoveryToken(token) {
  if (!token) return null;
  const [userId, exp, sig] = token.split('.');
  if (!userId || !exp || !sig || Date.now() > parseInt(exp)) return null;
  const expectedSig = crypto.createHmac('sha256', SECRET).update(`recover.${userId}.${exp}`).digest('hex').slice(0, 16);
  return sig === expectedSig ? userId : null;
}

// ─── HTML Template Function ─────────────────────────────────────────────────
function html(s, ...v) {
  html.H ??= class extends String { };
  html.E ??= x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return new html.H(s.reduce((o, t, i) => {
    const a = v[i];
    return o + t + (a == null || a === false ? ''
      : a instanceof html.H ? a
        : Array.isArray(a) ? a.flat(Infinity).map(x => x instanceof html.H ? x : html.E(x ?? '')).join('')
          : html.E(a));
  }, ''));
}

// ─── HTML Rendering ──────────────────────────────────────────────────────────
function renderCreateForm(deviceId, ua) {
  return String(html`<!DOCTYPE html><html><head><base href="/${COMPONENT_NAME}/"><title>Create User</title>
  <style>body{font-family:system-ui;max-width:600px;margin:2rem auto;padding:1rem;background:#0f172a;color:#e2e8f0;} h1{color:#4ade80;} input,button{padding:0.75rem;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;width:100%;margin-bottom:1rem;} button{background:#16a34a;border:none;cursor:pointer;} .card{background:#1e293b;padding:1.5rem;border-radius:8px;margin-bottom:2rem;}</style>
  </head><body>
  <h1>🌲 Create User</h1>
  <div class="card">
    <p>Device ID: <code>${deviceId.slice(0, 12)}...</code></p>
    <p>Browser: ${ua.browser} • OS: ${ua.os}</p>
    <form method="POST" action="./create">
      <label>Display Name</label>
      <input name="label" required maxlength="50" placeholder="e.g. Alice">
      <button type="submit">Create User</button>
    </form>
  </div>
  <div class="card">
    <h2>🔗 Claim Recovery Link</h2>
    <form method="POST" action="./claim-link">
      <input name="token" required placeholder="Paste recovery token">
      <button type="submit">Claim Link</button>
    </form>
  </div>
  <script>
  (function() {
    const hash = window.location.hash;
    if (!hash.startsWith('#recover=')) return;
    const token = decodeURIComponent(hash.slice('#recover='.length));
    fetch('./claim-link', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: 'token=' + encodeURIComponent(token) })
      .then(res => { if (res.redirected) window.location.href = res.url; else window.location.reload(); });
  })();
  </script>
  </body></html>`);
}

function renderDashboard(user, devices, currentDeviceId) {
  return String(html`<!DOCTYPE html><html><head><base href="/${COMPONENT_NAME}/"><title>User Dashboard</title>
  <style>body{font-family:system-ui;max-width:600px;margin:2rem auto;padding:1rem;background:#0f172a;color:#e2e8f0;} h1{color:#4ade80;} h2{color:#94a3b8;margin-top:2rem;} input,button,select{padding:0.75rem;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;margin-bottom:1rem;} button{background:#16a34a;border:none;cursor:pointer;} .card{background:#1e293b;padding:1.5rem;border-radius:8px;margin-bottom:2rem;} label{display:block;margin-bottom:0.5rem;color:#94a3b8;}</style>
  </head><body>
  <h1>🌲 User Dashboard</h1>

  <div class="card">
    <h2>👤 Profile</h2>
    <form method="POST" action="./profile">
      <label>Display Name</label>
      <input name="label" value="${user.label}" required maxlength="50">
      <button type="submit">Save</button>
    </form>
  </div>

  <div class="card">
    <h2>📱 Devices (${devices.length})</h2>
    ${devices.map(d => html`
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid #334155;">
          <div>
            <strong>${d.isInitial ? '👑 Initial' : '📱 Linked'}</strong>
            <code style="margin-left:0.5rem;">${d.id.slice(0, 8)}</code>
            <div style="font-size:0.75rem;color:#94a3b8;margin-top:0.25rem;">${d.browser} • ${d.os}</div>
            ${d.id === currentDeviceId ? html`<span style="color:#4ade80;font-size:0.75rem;">(This device)</span>` : ''}
          </div>
          ${!d.isInitial ? html`
            <form method="POST" action="./unlink" style="margin:0;">
              <input type="hidden" name="target" value="${d.id}">
              <button type="submit" style="width:auto;padding:0.3rem 0.6rem;background:#7f1d1d;">Unlink</button>
            </form>` : ''}
        </div>`)}
  </div>

  <div class="card">
    <h2>🔗 Generate Recovery Link</h2>
    <form id="gen-form">
      <label>Link Valid For (Days)</label>
      <select name="ttl">
        <option value="1">1 Day</option>
        <option value="7" selected>7 Days</option>
        <option value="30">30 Days</option>
      </select>
      <button type="submit">Generate Token</button>
    </form>
    <div id="token-result" style="display:none; margin-top:1rem;">
      <div style="background:#064e3b;padding:1rem;border-radius:8px;">
        <strong>Recovery Link Generated!</strong>
        <div style="background:#0f172a;padding:0.75rem;border-radius:6px;font-family:monospace;font-size:0.8rem;word-break:break-all;margin:0.5rem 0;" id="recovery-url"></div>
        <button id="copy-btn" style="width:auto;padding:0.4rem 0.8rem;">Copy Link</button>
      </div>
    </div>
  </div>

  <script>
    (function() {
      const hash = window.location.hash;
      if (!hash.startsWith('#recover=')) return;
      const token = decodeURIComponent(hash.slice('#recover='.length));
      fetch('./claim-link', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: 'token=' + encodeURIComponent(token) })
        .then(res => { if (res.redirected) window.location.href = res.url; else window.location.reload(); });
    })();

    document.getElementById('gen-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const ttl = e.target.ttl.value;
      const res = await fetch('./generate-link', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: 'ttl=' + ttl
      });
      if (res.ok) {
        const data = await res.json();
        document.getElementById('recovery-url').textContent = data.url;
        document.getElementById('token-result').style.display = 'block';
      } else {
        alert('Failed to generate token');
      }
    });

    document.getElementById('copy-btn')?.addEventListener('click', () => {
      const url = document.getElementById('recovery-url').textContent;
      navigator.clipboard.writeText(url).then(() => {
        const btn = document.getElementById('copy-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy Link', 1500);
      });
    });
  </script>
  </body></html>`);
}

function renderPublicProfile(user) {
  return String(html`<!DOCTYPE html><html><head><title>${user.label}</title>
  <style>body{font-family:system-ui;max-width:600px;margin:4rem auto;text-align:center;background:#0f172a;color:#e2e8f0;} h1{color:#4ade80;font-size:3rem;}</style>
  </head><body>
  <h1>${user?.label}</h1>
  <p style="color:#94a3b8;">Public Profile</p>
  </body></html>`);
}

// ─── Generate Unique User ID ────────────────────────────────────────────────
function generateUserId() {
  for (let i = 0; i < 10; i++) {
    const id = crypto.randomBytes(4).toString('hex');
    if (!existsSync(userPath(id))) return id;
  }
  throw new Error('Failed to generate unique user ID');
}

// ─── Helper: Read POST body ─────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const deviceId = req.headers['x-forest-device-id'];
  const ua = parseUserAgent(req.headers['user-agent']);

  try {
    // ─── Public Profile (No Auth) ─────────────────────────────────────────
    if (path.startsWith('/u/') && req.method === 'GET') {
      const userId = path.split('/')[2];
      const userQuads = (await loadUserIndex(userId))?.quads || [];
      const user = getUserProfile(userQuads, userId);
      if (!user.createdAt) { res.writeHead(404); return res.end('User not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderPublicProfile(user));
    }

    // ─── Auth Required ────────────────────────────────────────────────────
    if (!deviceId) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      return res.end('<h1>403 Forbidden</h1>');
    }

    if (req.method === 'POST' && !checkRateLimit(`post:${deviceId}`, RATE_MAX_POST)) {
      res.writeHead(429, { 'Content-Type': 'text/html' });
      return res.end('<h1>429 Too Many Requests</h1>');
    }

    // ─── Dashboard ────────────────────────────────────────────────────────
    if (path === '/' && req.method === 'GET') {
      const userId = deviceMap.get(deviceId);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (!userId) return res.end(renderCreateForm(deviceId, ua));
      const userQuads = (await loadUserIndex(userId))?.quads || [];
      const user = getUserProfile(userQuads, userId);
      const devices = getUserDevices(userQuads, userId);
      return res.end(renderDashboard(user, devices, deviceId));
    }

    // ─── Create User ──────────────────────────────────────────────────────
    if (path === '/create' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const label = (params.get('label')?.trim() || '').slice(0, 50);
      if (!label) { res.writeHead(400); return res.end('Display name required'); }

      if (deviceMap.has(deviceId)) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        return res.end(`<h1>Device Already Claimed</h1><p><a href="./">Back</a></p>`);
      }

      const userId = generateUserId();
      const createdAt = new Date().toISOString();
      const shortId = deviceId.slice(0, 8);
      const safeLabel = label.replace(/[\[\]{}]/g, '');

      const content = md`[user] <${PREFIX}>

# ${safeLabel} {=user:account/${userId} .user:User .prov:Agent label}

Was created from device [${shortId}] {=user:device/${deviceId} .user:Device ?user:hasDevice ?user:hadInitialDevice} via [${ua.browser}] {user:browser} on [${ua.os}] {user:os} at *${createdAt}* {user:createdAt ^^xsd:dateTime}.
`;
      await writeFile(userPath(userId), content);
      deviceMap.set(deviceId, userId);
      await syncStateFile();
      res.writeHead(303, { 'Location': './' }); res.end();
      return;
    }

    // ─── Internal API: /me ────────────────────────────────────────────────
    if (path === '/me' && req.method === 'GET') {
      const userId = deviceMap.get(deviceId);
      if (!userId) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ authenticated: false, userId: null }));
      }
      const userQuads = (await loadUserIndex(userId))?.quads || [];
      const user = getUserProfile(userQuads, userId);
      const devices = getUserDevices(userQuads, userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        authenticated: true,
        userId: user.id,
        label: user.label,
        isInitialDevice: devices.find(d => d.id === deviceId)?.isInitial || false,
      }));
    }

    // ─── Update Profile ───────────────────────────────────────────────────
    if (path === '/profile' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const userId = deviceMap.get(deviceId);
      if (!userId) { res.writeHead(403); return res.end('Not associated'); }

      const newLabel = (params.get('label')?.trim() || '').slice(0, 50);
      const text = await readFile(userPath(userId), 'utf8');
      const result = parse({ text });

      const userNode = namedNode(expandIRI(`user:account/${userId}`, CONTEXT));
      const labelQuad = result.quads.find(q =>
        q.subject.equals(userNode) && q.predicate.value === RDFS_LABEL
      );

      if (labelQuad) {
        const updatedText = updateValue({ text, quad: labelQuad, value: newLabel, origin: result.origin });
        await writeFile(userPath(userId), updatedText);
      }

      res.writeHead(303, { 'Location': './' }); res.end();
      return;
    }

    // ─── Generate Recovery Link ───────────────────────────────────────────
    if (path === '/generate-link' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const ttl = parseInt(params.get('ttl')) || 7;
      const userId = deviceMap.get(deviceId);

      if (!userId) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not associated' }));
      }

      const token = createRecoveryToken(userId, ttl);
      const baseUrl = process.env.PUBLIC_URL || req.headers.origin || `http://localhost:${FOREST_CORE_PORT}`;
      const url = `${baseUrl}/${COMPONENT_NAME}/#recover=${token}`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, url }));
      return;
    }

    // ─── Claim Recovery Link ──────────────────────────────────────────────
    if (path === '/claim-link' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const targetUserId = verifyRecoveryToken(params.get('token')?.trim());
      if (!targetUserId) { res.writeHead(400); return res.end('Invalid or expired token.'); }

      if (deviceMap.has(deviceId)) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        return res.end(`<h1>Device Already Claimed</h1><p><a href="./">Back</a></p>`);
      }

      const shortId = deviceId.slice(0, 8);
      const userQuads = (await loadUserIndex(targetUserId))?.quads || [];
      const user = getUserProfile(userQuads, targetUserId);
      const safeLabel = user.label.replace(/[\[\]{}]/g, '');

      const block = `\n*${safeLabel}* {=user:account/${targetUserId}} added [${shortId}] {=user:device/${deviceId} .user:Device ?user:hasDevice} via [${ua.browser}] {user:browser} on [${ua.os}] {user:os} at *${new Date().toISOString()}* {user:addedAt ^^xsd:dateTime}.\n`;
      await appendFile(userPath(targetUserId), block);

      deviceMap.set(deviceId, targetUserId);
      await syncStateFile();

      res.writeHead(303, { 'Location': './' }); res.end();
      return;
    }

    // ─── Unlink Device ────────────────────────────────────────────────────
    if (path === '/unlink' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const targetDeviceId = params.get('target')?.trim();
      if (!targetDeviceId) { res.writeHead(303, { 'Location': './' }); return res.end(); }

      const userId = deviceMap.get(deviceId);
      if (!userId) { res.writeHead(403); return res.end('Forbidden'); }

      const shortId = targetDeviceId.slice(0, 8);
      const userQuads = (await loadUserIndex(userId))?.quads || [];
      const user = getUserProfile(userQuads, userId);
      const safeLabel = user.label.replace(/[\[\]{}]/g, '');

      const block = `\n*${safeLabel}* {=user:account/${userId}} removed device [${shortId}] {=user:device/${targetDeviceId} -?user:hasDevice} from the account at *${new Date().toISOString()}* {user:removedAt ^^xsd:dateTime}.\n`;
      await appendFile(userPath(userId), block);

      deviceMap.delete(targetDeviceId);
      await syncStateFile();
      res.writeHead(303, { 'Location': './' }); res.end();
      return;
    }

    res.writeHead(404); res.end('Not Found');
  } catch (err) {
    console.error('[user] Error:', err);
    res.writeHead(500); res.end('Internal Server Error');
  }
});

// ─── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  await mkdir(PROFILES_DIR, { recursive: true });
  await rebuildDeviceMap();

  server.listen(process.env.SOCKET_PATH, () => {
    console.log(`[user] 🌲 Ready (${deviceMap.size} devices mapped)`);
  });
}

boot();