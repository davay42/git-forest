#!/usr/bin/env node
import { createServer, request, Agent } from "node:http";
import { spawn, execFile } from "node:child_process";
import { readdir, readFile, unlink, stat, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { promisify } from "node:util";
import crypto from "node:crypto";
import net from "node:net";

const exec = promisify(execFile);

// ─── CONFIGURATION ─────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
const ROOT = process.cwd();
const PUBLIC_DIR = join(ROOT, 'public');
const GIT_SECRET = process.env.GIT_SECRET;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const GIT_BACKUP_URL = process.env.GIT_BACKUP_URL;
const RELOAD_TOKEN = process.env.RELOAD_TOKEN || crypto.randomBytes(16).toString('hex');

const envInt = (key, fallback) => {
  const val = parseInt(process.env[`FOREST_${key}`], 10);
  return Number.isFinite(val) ? val : fallback;
};

const RATE_LIMIT_MAX = envInt('RATE_LIMIT_MAX', 5);
const RATE_LIMIT_WINDOW_MS = envInt('RATE_LIMIT_WINDOW_MS', 60000);
const RATE_LIMIT_CLEANUP_MS = envInt('RATE_LIMIT_CLEANUP_MS', 60000);
const COMPONENT_READY_TIMEOUT_MS = envInt('COMPONENT_READY_TIMEOUT_MS', 2000);
const COMPONENT_RESTART_DELAY_MS = envInt('COMPONENT_RESTART_DELAY_MS', 3000);
const COMPONENT_CLEANUP_DELAY_MS = envInt('COMPONENT_CLEANUP_DELAY_MS', 5000);
const PROXY_MAX_SOCKETS = envInt('PROXY_MAX_SOCKETS', 128);
const BACKUP_INITIAL_DELAY_MS = envInt('BACKUP_INITIAL_DELAY_MS', 10000);
const BACKUP_INTERVAL_MS = envInt('BACKUP_INTERVAL_MS', 300000);
const SHUTDOWN_TIMEOUT_MS = envInt('SHUTDOWN_TIMEOUT_MS', 5000);
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'forest_session';
const MAX_AGE_DAYS = envInt('AUTH_MAX_AGE_DAYS', 90);
const RENEWAL_WINDOW_DAYS = envInt('AUTH_RENEWAL_WINDOW_MS', 30);

// ─── GIT HTTP BACKEND DISCOVERY ────────────────────────────────────────────
function discoverGitBackend() {
  if (process.env.GIT_HTTP_BACKEND) return process.env.GIT_HTTP_BACKEND;
  const paths = [
    '/usr/libexec/git-core/git-http-backend',
    '/usr/local/libexec/git-core/git-http-backend',
    '/opt/homebrew/libexec/git-core/git-http-backend',
    '/Library/Developer/CommandLineTools/usr/libexec/git-core/git-http-backend',
    '/usr/lib/git-core/git-http-backend',
  ];
  return paths.find(existsSync) || paths[0];
}

const GIT_HTTP_BACKEND = discoverGitBackend();

// ─── STATE ──────────────────────────────────────────────────────────────────
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".md": "text/markdown", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon" };
const proxyAgent = new Agent({ keepAlive: true, maxSockets: PROXY_MAX_SOCKETS });
const components = new Map();
const deviceUserMap = new Map(); // deviceId → userId
let isReloading = false;
const startTime = Date.now();


// ─── GIT COMMIT QUEUE (MUTEX) ──────────────────────────────────────────────
let gitQueue = Promise.resolve();

async function queueGitCommit(files, message) {
  const currentQueue = gitQueue;
  let resolveTask;
  const taskPromise = new Promise(r => resolveTask = r);
  gitQueue = taskPromise;

  try {
    await currentQueue.catch(() => { });
    const fileList = Array.isArray(files) ? files : [files];
    const addArgs = fileList.length > 0 ? ['add', ...fileList] : ['add', '.'];

    await exec('git', addArgs, { cwd: ROOT });
    const { stdout } = await exec('git', ['diff', '--staged', '--name-only'], { cwd: ROOT });

    if (!stdout.trim()) {
      const result = { status: 'ok', message: 'No changes to commit' };
      resolveTask(result);
      return result;
    }

    await exec('git', ['commit', '-m', message || 'chore: auto-commit'], { cwd: ROOT });
    const result = { status: 'ok', message: 'Committed successfully' };
    resolveTask(result);
    return result;
  } catch (err) {
    console.error('[git-queue] Error:', err.message);
    const result = { status: 'error', message: err.message };
    resolveTask(result);
    return result;
  }
}

// ─── SECURITY UTILITIES ────────────────────────────────────────────────────
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a)), bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const authBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authBuckets) {
    if (now > entry.resetAt) authBuckets.delete(ip);
  }
}, RATE_LIMIT_CLEANUP_MS).unref();

function isRateLimited(ip) {
  const entry = authBuckets.get(ip);
  return entry && Date.now() <= entry.resetAt && entry.count >= RATE_LIMIT_MAX;
}

function recordFailedAuth(ip) {
  const now = Date.now();
  const entry = authBuckets.get(ip);
  if (!entry || now > entry.resetAt) {
    if (authBuckets.size > 10000) authBuckets.clear();
    authBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    entry.count++;
  }
}

function getClientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

function addSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

// ─── IDENTITY KERNEL (FIP) ──────────────────────────────────────────────────
function signDevice(deviceId, issuedAt) {
  return crypto.createHmac('sha256', AUTH_SECRET)
    .update(`${deviceId}.${issuedAt}`)
    .digest('hex');
}

function processIdentity(req, res) {
  const cookieMatch = req.headers.cookie?.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  const token = cookieMatch ? cookieMatch[1] : null;

  let deviceId = null;
  let issuedAt = Date.now();
  let needsRenewal = false;

  if (token) {
    const parts = token.split('.');
    if (parts.length === 3) {
      const [dId, iAt, sig] = parts;
      const expectedSig = signDevice(dId, iAt);
      const sigBuffer = Buffer.from(sig, 'utf8');
      const expectedSigBuffer = Buffer.from(expectedSig, 'utf8');

      if (timingSafeEqual(sigBuffer, expectedSigBuffer)) {
        deviceId = dId;
        issuedAt = parseInt(iAt, 10);
        if (Date.now() - issuedAt > RENEWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
          needsRenewal = true;
        }
      }
    }
  }

  if (!deviceId) {
    deviceId = crypto.randomBytes(16).toString('hex');
    issuedAt = Date.now();
    needsRenewal = true;
  }

  if (needsRenewal) {
    const newToken = `${deviceId}.${issuedAt}.${signDevice(deviceId, issuedAt)}`;
    const isSecure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    const maxAgeSeconds = MAX_AGE_DAYS * 24 * 60 * 60;

    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${newToken}; HttpOnly; ${isSecure ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
    );
  }

  req.forestDeviceId = deviceId;
}

// ─── COMPONENT LIFECYCLE ───────────────────────────────────────────────────
async function swapComponent(name) {
  const oldComponent = components.get(name);
  const socketPath = `/tmp/forest-${name}-${Date.now()}.sock`;
  const scriptPath = join(ROOT, name, "index.js");

  await unlink(socketPath).catch(() => { });
  console.log(`[sync] 🌱 Starting /${name}...`);

  const newProc = spawn("node", [scriptPath], {
    env: {
      ...process.env,
      SOCKET_PATH: socketPath,
      COMPONENT_NAME: name,
      COMPONENT_DIR: join(ROOT, name),
      FOREST_CORE_PORT: PORT
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  });

  let ready = false;
  let exitedEarly = false;

  await new Promise((resolve) => {
    const done = () => resolve();

    // Unified IPC Listener: Handles 'ready' signal and 'commit' requests
    newProc.on('message', async (msg) => {
      if (msg === 'ready') {
        ready = true;
        done();
      } else if (msg && msg.type === 'commit') {
        // ─── IPC COMMIT SANDBOX ─────────────────────────────────────────
        const files = Array.isArray(msg.files) ? msg.files : [msg.files];
        const isSafe = files.every(f => {
          if (typeof f !== 'string') return false;
          if (f === name || f.startsWith(`${name}/`)) return true;
          const parts = f.split('/');
          if (parts[0] === 'users' && parts.length === 3 && parts[2] === `${name}.md`) return true;
          if (name === 'users' && f.startsWith('users/')) return true;
          return false;
        }) else if (msg && msg.type === 'device-map') {
          deviceUserMap.set(msg.deviceId, msg.userId);
        } else if (msg && msg.type === 'device-unmap') {
          deviceUserMap.delete(msg.deviceId);
        }

        if (!isSafe) {
          console.warn(`[security] /${name} attempted out-of-scope IPC commit:`, files);
          return;
        }

        await queueGitCommit(files, msg.message || `chore: update ${name}`);
      }
    });

    newProc.once('exit', (code) => { exitedEarly = true; done(); });
    setTimeout(done, COMPONENT_READY_TIMEOUT_MS);
  });

  if (!ready) {
    console.log(`[sync] ❌ /${name} failed to start (ready=${ready}, exited=${exitedEarly}) — keeping previous version live`);
    if (!exitedEarly) newProc.kill("SIGKILL");
    return;
  }

  components.set(name, { socketPath, proc: newProc, startTime: Date.now() });
  console.log(`[sync] 🔄 Swapped router for /${name}`);

  if (oldComponent) {
    oldComponent.proc.kill("SIGTERM");
    setTimeout(() => unlink(oldComponent.socketPath).catch(() => { }), COMPONENT_CLEANUP_DELAY_MS);
  }

  newProc.on("exit", (code) => {
    if (code !== 0 && code !== null && components.get(name)?.proc === newProc) {
      console.log(`[error] /${name} crashed with code ${code}. Restarting in 3s...`);
      components.delete(name);
      setTimeout(() => swapComponent(name), COMPONENT_RESTART_DELAY_MS);
    }
  });
}

function killComponent(name) {
  const component = components.get(name);
  if (component) {
    component.proc.kill("SIGTERM");
    setTimeout(() => unlink(component.socketPath).catch(() => { }), COMPONENT_CLEANUP_DELAY_MS);
  }
}

// ─── STATIC FILE SERVER ────────────────────────────────────────────────────
async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const safePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  const relPath = filePath.slice(PUBLIC_DIR.length);
  const blockedNames = ['.git', '.env', '.env.local', '.env.production', '.DS_Store'];
  const parts = relPath.split('/');
  if (parts.some(p => blockedNames.includes(p))) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const stats = await stat(filePath);
    let finalPath = filePath;
    if (stats.isDirectory()) {
      finalPath = join(filePath, 'index.html');
    }
    const content = await readFile(finalPath);
    const type = MIME[extname(finalPath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    res.end(content);
  } catch {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;max-width:600px;margin:4rem auto;text-align:center;color:#1a1a1a;">
        <h1>🌲 git-forest is running!</h1>
        <p>Your forest is alive, but the canopy is empty.</p>
        <p>Create a <code>public/index.html</code> file to build your frontend, or add a folder with an <code>index.js</code> to create a backend component.</p>
        <hr style="margin:2rem 0;border:none;border-top:1px solid #e5e7eb;">
        <p style="color:#6b7280;font-size:0.9rem;">Active Components: <strong>${components.size}</strong></p>
        <ul style="list-style:none;padding:0;">${[...components.keys()].map(c => `<li><a href="/${c}" style="color:#2563eb;">/${c}</a></li>`).join('') || '<li style="color:#9ca3af;">None yet. Create a directory with an index.js to start.</li>'}</ul>
      </body></html>`);
    }
    res.writeHead(404);
    res.end("Not Found");
  }
}

// ─── GIT HTTP BACKEND ──────────────────────────────────────────────────────
function checkGitAuth(req, res, ip) {
  if (!GIT_SECRET) return "git-user";

  if (isRateLimited(ip)) {
    res.writeHead(429, { "Content-Type": "text/plain" });
    res.end("Too many failed attempts. Try again later.");
    return null;
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    recordFailedAuth(ip);
    res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"git-forest\"" });
    res.end("Unauthorized");
    return null;
  }

  const base64 = auth.split(" ")[1];
  const credentials = Buffer.from(base64, "base64").toString("utf-8");
  const [user, password] = credentials.split(":");

  if (!password || !timingSafeEqual(password, GIT_SECRET)) {
    recordFailedAuth(ip);
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return null;
  }
  return user || "git-user";
}

function handleGit(req, res, ip) {
  const remoteUser = checkGitAuth(req, res, ip);
  if (!remoteUser) return;

  const url = new URL(req.url, "http://localhost");
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: ROOT,
    GIT_DIR: join(ROOT, ".git"),
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: url.pathname.replace(/^\/git/, "") || "/",
    REQUEST_METHOD: req.method,
    CONTENT_TYPE: req.headers["content-type"] || "",
    CONTENT_LENGTH: req.headers["content-length"] || "",
    QUERY_STRING: url.search.slice(1),
    REMOTE_USER: remoteUser,
  };

  const git = spawn(GIT_HTTP_BACKEND, [], { env });
  if (req.method === "POST" && req.headers["content-length"]) {
    req.pipe(git.stdin);
  } else {
    git.stdin.end();
  }

  let buf = Buffer.alloc(0), parsed = false;
  git.stdout.on("data", (chunk) => {
    if (parsed) return res.write(chunk);
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end !== -1) {
      parsed = true;
      const hdr = buf.subarray(0, end).toString();
      const status = hdr.match(/Status: (\d+)/)?.[1] || 200;
      const headers = {};
      hdr.split("\r\n").forEach(l => {
        const i = l.indexOf(":");
        if (i > 0) {
          const k = l.slice(0, i).trim();
          if (k.toLowerCase() !== "status") headers[k] = l.slice(i + 1).trim();
        }
      });
      res.writeHead(parseInt(status), headers);
      res.write(buf.subarray(end + 4));
    }
  });
  git.stderr.on("data", d => console.error(`[git stderr] ${d.toString().trim()}`));
  git.on("close", (code) => { res.end(); });
}

// ─── HTTP PROXY ────────────────────────────────────────────────────────────
function proxyToComponent(req, res, segment, isSubdomain = false) {
  const component = components.get(segment);
  if (!component) {
    res.writeHead(502);
    return res.end("Component unavailable");
  }

  let strippedUrl = req.url;
  if (!isSubdomain) {
    const prefixLength = segment.length + 1;
    strippedUrl = req.url.slice(prefixLength);
    if (!strippedUrl.startsWith('/')) strippedUrl = '/' + strippedUrl;
  }

  const headers = { ...req.headers };
  if (req.forestDeviceId) headers['x-forest-device-id'] = req.forestDeviceId;

  const proxyReq = request({
    agent: proxyAgent,
    socketPath: component.socketPath,
    path: strippedUrl,
    method: req.method,
    headers
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", () => {
    res.writeHead(502);
    res.end("Component unavailable");
  });
  req.pipe(proxyReq);
}

// ─── BACKGROUND BACKUP SYNC ────────────────────────────────────────────────
async function syncToBackup() {
  if (!GIT_BACKUP_URL) return;

  try {
    try {
      await exec('git', ['remote', 'get-url', 'backup'], { cwd: ROOT });
    } catch {
      await exec('git', ['remote', 'add', 'backup', GIT_BACKUP_URL], { cwd: ROOT });
    }

    let needsPush = true;
    try {
      const { stdout: count } = await exec('git', ['rev-list', '--count', 'backup/main..main'], { cwd: ROOT });
      if (parseInt(count.trim(), 10) === 0) {
        needsPush = false;
      }
    } catch {
      needsPush = true;
    }

    if (!needsPush) return;

    console.log(`[backup] 🔄 New commits detected. Pushing to backup...`);
    await exec('git', ['push', '--set-upstream', 'backup', 'main'], { cwd: ROOT });
    console.log('[backup] ✅ Synced to backup');
  } catch (err) {
    console.error('[backup] ⚠️ Sync failed:', err.stderr || err.message);
  }
}

// ─── HTTP SERVER ────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  try {
    addSecurityHeaders(res);

    const internalToken = req.headers['x-forest-token'];
    const isReload = internalToken && (internalToken === RELOAD_TOKEN || (GIT_SECRET && timingSafeEqual(Buffer.from(internalToken, 'utf8'), Buffer.from(GIT_SECRET, 'utf8'))));
    const isInternalCall = isReload;

    if (!isInternalCall) {
      delete req.headers['x-forest-device-id'];
      delete req.headers['x-forest-token'];
      processIdentity(req, res);
      if (req.forestDeviceId) req.headers['x-forest-device-id'] = req.forestDeviceId;
      const userId = deviceUserMap.get(req.forestDeviceId);
      if (userId) req.headers['x-forest-user-id'] = userId;
    } else {
      if (req.headers['x-forest-device-id']) {
        req.forestDeviceId = req.headers['x-forest-device-id'];
      }
    }

    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const ip = getClientIp(req);

    const host = (req.headers.host || '').split(':')[0];
    const parts = host.split('.');
    const subdomain = parts[0];

    if (host !== 'localhost' && host !== '127.0.0.1' && parts.length > 1 && components.has(subdomain)) {
      return proxyToComponent(req, res, subdomain, true);
    }

    // Internal API: Health check
    if (path === "/_forest/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }

    // Internal API: Reload endpoint (Triggered by Git Hook)
    if (path === "/_forest/reload" && req.method === "POST") {
      const token = req.headers['x-forest-token'];
      const isValid = (token === RELOAD_TOKEN) || (GIT_SECRET && timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(GIT_SECRET, 'utf8')));

      if (!isValid) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        return res.end("Forbidden: Invalid reload token");
      }

      const changedDirsHeader = req.headers['x-forest-changed-dirs'];
      let targetComponents = null;

      if (changedDirsHeader) {
        targetComponents = changedDirsHeader.split(',').map(d => d.trim()).filter(d => d.length > 0);
      }

      performReload(targetComponents).catch(err => console.error("[sync] Async reload failed:", err));

      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("Reload triggered");
    }

    // Internal API: Status endpoint
    if (path === "/_forest/status" && req.method === "GET") {
      const uptime = Date.now() - startTime;
      const componentInfo = {};
      for (const [name, component] of components) {
        const componentUptime = component.startTime ? Date.now() - component.startTime : 0;
        componentInfo[name] = {
          socketPath: component.socketPath,
          pid: component.proc.pid,
          uptime_ms: componentUptime,
          uptime_human: `${Math.floor(componentUptime / 60000)}m ${Math.floor((componentUptime % 60000) / 1000)}s`
        };
      }

      const status = {
        status: "healthy",
        uptime: uptime,
        uptime_human: `${Math.floor(uptime / 60000)}m ${Math.floor((uptime % 60000) / 1000)}s`,
        port: PORT,
        components: componentInfo,
        component_count: components.size,
        git_auth_enabled: !!GIT_SECRET,
        proxy_trust_enabled: TRUST_PROXY,
        git_http_backend: GIT_HTTP_BACKEND,
        is_reloading: isReloading
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(status, null, 2));
    }

    // Git HTTP backend
    if (path.startsWith("/git")) return handleGit(req, res, ip);

    // Component routing
    const segment = path.split("/")[1];
    if (segment && components.has(segment)) {
      if (path === `/${segment}`) {
        res.writeHead(301, { "Location": `/${segment}/${url.search}` });
        return res.end();
      }
      return proxyToComponent(req, res, segment);
    }

    // Static files
    await serveStatic(req, res);
  } catch (err) {
    console.error("[core] Unhandled error:", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
});

// ─── RELOAD MANAGER ────────────────────────────────────────────────────────
async function performReload(targetComponents = null) {
  if (isReloading) return;
  isReloading = true;

  const targetMsg = targetComponents ? ` (Targeted: ${targetComponents.join(', ')})` : " (Full scan)";
  console.log(`[sync] 🔄 Performing reload${targetMsg}...`);

  try {
    const entries = await readdir(ROOT, { withFileTypes: true });
    const newFolders = new Set();

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "public") {
        if (existsSync(join(ROOT, entry.name, "index.js"))) {
          newFolders.add(entry.name);

          if (!targetComponents || targetComponents.includes(entry.name)) {
            await swapComponent(entry.name);
          }
        }
      }
    }

    for (const name of components.keys()) {
      if (!newFolders.has(name)) {
        console.log(`[sync] 🗑️ Removing deleted /${name}`);
        killComponent(name);
        components.delete(name);
      }
    }

    console.log(`[sync] ✅ Reload complete. Active: ${[...components.keys()].join(", ") || "none"}`);
  } catch (err) {
    console.error("[sync] Reload failed:", err);
  } finally {
    isReloading = false;
  }
}

// ─── GRACEFUL SHUTDOWN ──────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`[core] ⏹️ Received ${signal}. Closing HTTP server gracefully...`);
  server.close(() => {
    console.log('[core] ✅ Active connections finished. Exiting.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGHUP", () => performReload());
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── GIT HOOK MANAGEMENT ───────────────────────────────────────────────────
async function ensureGitHook() {
  const hooksDir = join(ROOT, '.git', 'hooks');
  if (!existsSync(hooksDir)) await mkdir(hooksDir, { recursive: true });

  const hookPath = join(hooksDir, 'post-receive');
  const hookContent = `#!/bin/sh
# Forest Git Hook - Dynamically generated by index.js
while read oldrev newrev refname; do
    if [ "$newrev" = "0000000000000000000000000000000000000000" ]; then continue; fi
    if [ "$refname" != "refs/heads/main" ] && [ "$refname" != "refs/heads/master" ]; then continue; fi
    if [ "$oldrev" = "0000000000000000000000000000000000000000" ]; then
        curl -s -X POST -H "x-forest-token: ${RELOAD_TOKEN}" http://localhost:\${FOREST_CORE_PORT:-3000}/_forest/reload > /dev/null 2>&1 || true
        continue
    fi
    if git diff --name-only $oldrev $newrev | grep -q "^index.js$"; then
        echo "[git-forest] Core updated. Triggering full container restart."
        kill -TERM 1
        exit 0
    fi
    CHANGED_DIRS=$(git diff --name-only $oldrev $newrev | grep -v "^index.js$" | grep -v "^public/" | grep -v "^\\.env" | sed 's|/.*||' | sort -u | tr '\\n' ',' | sed 's/,$//')
    if [ -n "$CHANGED_DIRS" ]; then
        echo "[git-forest] Targeted reload for: $CHANGED_DIRS"
        curl -s -X POST -H "x-forest-token: ${RELOAD_TOKEN}" -H "x-forest-changed-dirs: $CHANGED_DIRS" http://localhost:\${FOREST_CORE_PORT:-3000}/_forest/reload > /dev/null 2>&1 || true
    else
        echo "[git-forest] No specific component changes detected. Triggering full reload."
        curl -s -X POST -H "x-forest-token: ${RELOAD_TOKEN}" http://localhost:\${FOREST_CORE_PORT:-3000}/_forest/reload > /dev/null 2>&1 || true
    fi
done
`;

  try {
    await writeFile(hookPath, hookContent, { mode: 0o755 });
  } catch (err) {
    console.error('[boot] ❌ Failed to write post-receive hook:', err.message);
    throw err;
  }
}

// ─── GIT INITIALIZATION ────────────────────────────────────────────────────
async function freshInit() {
  console.log('[boot] 🌱 Initializing fresh Git repository...');
  try {
    await exec('git', ['init', '-b', 'main'], { cwd: ROOT });
    await exec('git', ['config', 'user.email', 'forest@local'], { cwd: ROOT });
    await exec('git', ['config', 'user.name', 'Forest Server'], { cwd: ROOT });
    await exec('git', ['config', 'receive.denyCurrentBranch', 'updateInstead'], { cwd: ROOT });
    await exec('git', ['add', '.'], { cwd: ROOT });

    const { stdout: staged } = await exec('git', ['diff', '--staged', '--name-only'], { cwd: ROOT });
    if (staged.trim()) {
      await exec('git', ['commit', '-m', 'chore: initial forest seed'], { cwd: ROOT });
      console.log('[boot] ✅ Initial files committed to Git.');
    }
    console.log('[boot] ✅ Git repository initialized and configured.');
  } catch (err) {
    console.error('[boot] ⚠️ Failed to initialize Git:', err.message);
  }
}

// ─── SELF-HEALING ───────────────────────────────────────────────────────────
async function healGitState() {
  try {
    const { stdout: status } = await exec('git', ['status', '--porcelain'], { cwd: ROOT });

    if (status.trim()) {
      console.log('[boot] 🩹 Dirty Git state detected. Healing...');
      await exec('git', ['add', '-u'], { cwd: ROOT });

      const { stdout: staged } = await exec('git', ['diff', '--staged', '--name-only'], { cwd: ROOT });
      if (staged.trim()) {
        await exec('git', ['commit', '-m', 'chore: auto-heal tracked files after boot'], { cwd: ROOT });
        console.log('[boot] ✅ Tracked files healed and committed.');
      } else {
        console.log('[boot] ℹ️ Dirty state consists only of untracked files (likely component data). Left uncommitted to protect Git history.');
      }
    }
  } catch (err) {
    console.error('[boot] ⚠️ Git heal failed:', err.message);
  }
}

// ─── WEBSOCKET UPGRADE HANDLER ──────────────────────────────────────────────
function setupWebSocketUpgrade() {
  server.on('upgrade', (req, socket, head) => {
    try {
      const internalToken = req.headers['x-forest-token'];
      const isReload = internalToken && (internalToken === RELOAD_TOKEN || (GIT_SECRET && timingSafeEqual(Buffer.from(internalToken, 'utf8'), Buffer.from(GIT_SECRET, 'utf8'))));
      const isInternalCall = isReload;

      if (!isInternalCall) {
        delete req.headers['x-forest-device-id'];
        delete req.headers['x-forest-token'];
        processIdentity(req, null);
        if (req.forestDeviceId) req.headers['x-forest-device-id'] = req.forestDeviceId;
      }

      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      const segment = path.split("/")[1];

      if (!segment || !components.has(segment)) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const component = components.get(segment);
      const componentSocket = net.connect(component.socketPath);

      componentSocket.on('connect', () => {
        const strippedPath = path.slice(segment.length + 1) || '/';
        const fullPath = strippedPath + url.search;

        let httpRequest = `${req.method} ${fullPath} HTTP/1.1\r\n`;
        for (const [key, value] of Object.entries(req.headers)) {
          if (Array.isArray(value)) {
            for (const v of value) httpRequest += `${key}: ${v}\r\n`;
          } else {
            httpRequest += `${key}: ${value}\r\n`;
          }
        }
        if (req.forestDeviceId) httpRequest += `x-forest-device-id: ${req.forestDeviceId}\r\n`;
        httpRequest += '\r\n';

        componentSocket.write(httpRequest);
        if (head && head.length > 0) componentSocket.write(head);

        socket.pipe(componentSocket);
        componentSocket.pipe(socket);
      });

      componentSocket.on('error', (err) => {
        console.error(`[ws] Component socket error:`, err.code, err.message);
        if (!socket.destroyed) {
          socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          socket.destroy();
        }
      });

      socket.on('error', (err) => {
        console.error(`[ws] Client socket error:`, err.code, err.message);
        componentSocket.destroy();
      });

      componentSocket.on('close', () => {
        if (!socket.destroyed) socket.destroy();
      });

      socket.on('close', () => {
        if (!componentSocket.destroyed) componentSocket.destroy();
      });
    } catch (err) {
      console.error('[ws] Upgrade handler exception:', err);
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
    }
  });
}

// ─── BOOT SEQUENCE ──────────────────────────────────────────────────────────
async function boot() {
  await healGitState();

  const lockFiles = ['.git/index.lock', '.git/config.lock', '.git/HEAD.lock'];
  for (const lock of lockFiles) {
    await unlink(join(ROOT, lock)).catch(() => { });
  }

  if (!existsSync(join(ROOT, '.git'))) {
    console.log('[boot] 🌱 No Git repository found.');
    if (GIT_BACKUP_URL) {
      console.log('[boot] 🔄 Attempting to restore from git backup...');
      try {
        await exec('git', ['clone', GIT_BACKUP_URL, '.'], { cwd: ROOT });
        console.log('[boot] ✅ Successfully restored from backup.');
      } catch (err) {
        console.error('[boot] ⚠️ Clone failed. Falling back to fresh init.', err.message);
        await freshInit();
      }
    } else {
      await freshInit();
    }
  }

  await ensureGitHook();
  console.log('[boot] 🪝 Git post-receive hook synced with current reload token.');

  const entries = await readdir(ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "public") {
      if (existsSync(join(ROOT, entry.name, "index.js"))) await swapComponent(entry.name);
    }
  }

  if (GIT_BACKUP_URL) {
    console.log(`[backup] 🔄 Git backup enabled. Syncing every ${BACKUP_INTERVAL_MS / 60000} minutes.`);
    setTimeout(syncToBackup, BACKUP_INITIAL_DELAY_MS);
    setInterval(syncToBackup, BACKUP_INTERVAL_MS);
  }

  server.listen(PORT, () => {
    console.log(`[ready] http://localhost:${PORT} | components: ${[...components.keys()].join(", ") || "none"}`);
    console.log(`[security] Git Auth: ${GIT_SECRET ? 'ENABLED (Timing-Safe)' : 'DISABLED'} | Proxy Trust: ${TRUST_PROXY ? 'ON' : 'OFF'}`);
    console.log(`[git] HTTP Backend: ${GIT_HTTP_BACKEND}`);
  });

  setupWebSocketUpgrade();
}

boot();