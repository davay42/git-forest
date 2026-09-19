#!/usr/bin/env node

import { createServer, request, Agent } from "node:http";
import { spawn, execFile } from "node:child_process";
import { readdir, readFile, unlink, stat, mkdir, writeFile } from "node:fs/promises"; // Added stat, removed access
import { join, extname } from "node:path";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const PUBLIC_DIR = join(ROOT, 'public'); // 🚀 NEW: Strict static boundary
const GIT_SECRET = process.env.GIT_SECRET;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const GITHUB_BACKUP_URL = process.env.GITHUB_BACKUP_URL;

const RELOAD_TOKEN = crypto.randomBytes(16).toString('hex');

// ─── GIT HTTP BACKEND DISCOVERY ───────────────────────────────────────────
function discoverGitHttpBackend() {
  if (process.env.GIT_HTTP_BACKEND) return process.env.GIT_HTTP_BACKEND;
  const commonPaths = [
    '/usr/libexec/git-core/git-http-backend',
    '/usr/local/libexec/git-core/git-http-backend',
    '/opt/homebrew/libexec/git-core/git-http-backend',
    '/Library/Developer/CommandLineTools/usr/libexec/git-core/git-http-backend',
    '/usr/lib/git-core/git-http-backend',
  ];
  for (const path of commonPaths) {
    if (existsSync(path)) return path;
  }
  return '/usr/libexec/git-core/git-http-backend';
}

const GIT_HTTP_BACKEND = discoverGitHttpBackend();

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".md": "text/markdown", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon" };

const proxyAgent = new Agent({ keepAlive: true, maxSockets: 128 });
const components = new Map();
const componentTokens = new Map();
let isReloading = false;
const startTime = Date.now();

// ─── CENTRALIZED GIT QUEUE (MUTEX) ─────────────────────────────────────
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
    await execFileAsync('git', addArgs, { cwd: ROOT });

    const { stdout } = await execFileAsync('git', ['diff', '--staged', '--name-only'], { cwd: ROOT });
    if (!stdout.trim()) {
      const result = { status: 'ok', message: 'No changes to commit' };
      resolveTask(result);
      return result;
    }

    await execFileAsync('git', ['commit', '-m', message || 'chore: auto-commit'], { cwd: ROOT });
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

// ─── SECURITY UTILITIES ────────────────────────────────────────────────
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a)), bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const authBuckets = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = authBuckets.get(ip);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= 5;
}

function recordFailedAuth(ip) {
  const now = Date.now();
  const entry = authBuckets.get(ip);
  if (!entry || now > entry.resetAt) {
    authBuckets.set(ip, { count: 1, resetAt: now + 60000 });
  } else {
    entry.count++;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authBuckets) if (now > entry.resetAt) authBuckets.delete(ip);
}, 60000).unref();

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

// ─── ZERO-DOWNTIME SWAP LOGIC (HARDENED) ───────────────────────────────
async function swapComponent(name) {
  const oldComponent = components.get(name);
  const newSocketPath = `/tmp/forest-${name}-${Date.now()}.sock`;
  const scriptPath = join(ROOT, name, "index.js");
  await unlink(newSocketPath).catch(() => { });
  console.log(`[sync] 🌱 Starting new /${name}...`);

  const componentToken = crypto.randomBytes(16).toString('hex');

  const newProc = spawn("node", [scriptPath], {
    env: {
      ...process.env,
      SOCKET_PATH: newSocketPath,
      COMPONENT_NAME: name,
      COMPONENT_DIR: join(ROOT, name),
      FOREST_COMPONENT_TOKEN: componentToken,
      FOREST_CORE_PORT: PORT
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  });

  componentTokens.set(componentToken, name);

  let ready = false;
  let exitedEarly = false;

  await new Promise((resolve) => {
    const done = () => resolve();
    newProc.once('message', (msg) => { if (msg === 'ready') { ready = true; done(); } });
    newProc.once('exit', (code) => { exitedEarly = true; done(); });
    setTimeout(done, 2000);
  });

  if (!ready) {
    console.log(`[sync] ❌ /${name} failed to start (ready=${ready}, exited=${exitedEarly}) — keeping previous version live`);
    if (!exitedEarly) newProc.kill("SIGKILL");
    componentTokens.delete(componentToken);
    return;
  }

  components.set(name, { socketPath: newSocketPath, proc: newProc, token: componentToken, startTime: Date.now() });
  console.log(`[sync] 🔄 Swapped router for /${name}`);

  if (oldComponent) {
    componentTokens.delete(oldComponent.token);
    oldComponent.proc.kill("SIGTERM");
    setTimeout(() => unlink(oldComponent.socketPath).catch(() => { }), 5000);
  }

  newProc.on("exit", (code) => {
    if (code !== 0 && code !== null && components.get(name)?.proc === newProc) {
      console.log(`[error] /${name} crashed with code ${code}. Restarting in 3s...`);
      componentTokens.delete(componentToken);
      components.delete(name);
      setTimeout(() => swapComponent(name), 3000);
    }
  });
}

function killComponent(name) {
  const component = components.get(name);
  if (component) {
    componentTokens.delete(component.token);
    component.proc.kill("SIGTERM");
    setTimeout(() => unlink(component.socketPath).catch(() => { }), 5000);
  }
}

process.on("SIGHUP", async () => {
  if (isReloading) return;
  isReloading = true;
  console.log("[sync] 🔄 Received reload signal. Performing zero-downtime swap...");
  try {
    const entries = await readdir(ROOT, { withFileTypes: true });
    const newFolders = new Set();
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "public") {
        if (existsSync(join(ROOT, entry.name, "index.js"))) {
          newFolders.add(entry.name);
          await swapComponent(entry.name);
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
  } catch (err) { console.error("[sync] Reload failed:", err); }
  finally { isReloading = false; }
});

// ─── HTTP HANDLING ─────────────────────────────────────────────────────
async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  // Strip leading slashes to prevent path traversal via //../
  const safePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const filePath = join(PUBLIC_DIR, safePath);

  // Strict boundary check: MUST be inside PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  // Block hidden files and env vars just in case they are in public/
  const relPath = filePath.slice(PUBLIC_DIR.length);
  const blockedNames = ['.git', '.env', '.env.local', '.env.production', '.DS_Store'];
  const parts = relPath.split('/');
  if (parts.some(p => blockedNames.includes(p))) {
    res.writeHead(403); return res.end("Forbidden");
  }

  try {
    const stats = await stat(filePath);
    let finalPath = filePath;

    // 🚀 NEW: If it's a directory, automatically look for index.html
    if (stats.isDirectory()) {
      finalPath = join(filePath, 'index.html');
    }

    const content = await readFile(finalPath);
    const type = MIME[extname(finalPath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    res.end(content);
  } catch {
    // 🚀 NEW: Beautiful First-Run Fallback
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

  if (!password || !timingSafeEqualStr(password, GIT_SECRET)) {
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
  if (req.method === "POST" && req.headers["content-length"]) req.pipe(git.stdin);
  else git.stdin.end();

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
        if (i > 0) { const k = l.slice(0, i).trim(); if (k.toLowerCase() !== "status") headers[k] = l.slice(i + 1).trim(); }
      });
      res.writeHead(parseInt(status), headers);
      res.write(buf.subarray(end + 4));
    }
  });
  git.stderr.on("data", d => console.error(`[git stderr] ${d.toString().trim()}`));
  git.on("close", (code) => { res.end(); });
}

function proxyToComponent(req, res, segment) {
  const component = components.get(segment);
  if (!component) { res.writeHead(502); return res.end("Component unavailable"); }

  const prefixLength = segment.length + 1;
  let strippedUrl = req.url.slice(prefixLength);
  if (!strippedUrl.startsWith('/')) strippedUrl = '/' + strippedUrl;

  const proxyReq = request({
    agent: proxyAgent, socketPath: component.socketPath, path: strippedUrl, method: req.method, headers: req.headers
  }, (proxyRes) => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res); });
  proxyReq.on("error", () => { res.writeHead(502); res.end("Component unavailable"); });
  req.pipe(proxyReq);
}

// ─── BACKGROUND BACKUP SYNC ────────────────────────────────────────────
async function syncToBackup() {
  if (!GITHUB_BACKUP_URL) return;

  try {
    // 1. Ensure the 'backup' remote exists locally (Local operation)
    try {
      await execFileAsync('git', ['remote', 'get-url', 'backup'], { cwd: ROOT });
    } catch {
      // If it doesn't exist, add it
      await execFileAsync('git', ['remote', 'add', 'backup', GITHUB_BACKUP_URL], { cwd: ROOT });
    }

    // 2. Check if local 'main' has commits that 'backup/main' doesn't have.
    // This checks the LOCAL Git database. NO network ping occurs here.
    let needsPush = true;
    try {
      const { stdout: count } = await execFileAsync('git', ['rev-list', '--count', 'backup/main..main'], { cwd: ROOT });
      if (parseInt(count.trim(), 10) === 0) {
        needsPush = false; // We are perfectly in sync
      }
    } catch {
      // If the 'backup/main' tracking ref doesn't exist yet (first run), we need to push
      needsPush = true;
    }

    // 3. Abort if there's nothing to do
    if (!needsPush) return;

    // 4. Push only when necessary (Network operation)
    console.log(`[backup] 🔄 New commits detected. Pushing to GitHub...`);
    await execFileAsync('git', ['push', 'backup', 'main'], { cwd: ROOT });
    console.log('[backup] ✅ Synced to GitHub');

  } catch (err) {
    console.error('[backup] ⚠️ Sync failed:', err.stderr || err.message);
  }
}

// ─── THE GATEWAY ───────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  try {
    addSecurityHeaders(res);
    const url = new URL(req.url, "http://localhost");
    let path = url.pathname;
    const ip = getClientIp(req);

    if (path === "/_forest/commit" && req.method === "POST") {
      const token = req.headers['x-forest-token'];
      const componentName = componentTokens.get(token);

      if (!componentName) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        return res.end("Forbidden: Invalid component token");
      }

      let body = "";
      req.on("data", chunk => {
        body += chunk;
        if (body.length > 1e6) req.destroy();
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          let files = payload.files || [];
          if (!Array.isArray(files)) files = [files];

          const componentPrefix = `${componentName}/`;
          const isSafe = files.every(f => typeof f === 'string' && (f.startsWith(componentPrefix) || f === componentName));

          if (!isSafe) {
            console.warn(`[security] Component ${componentName} attempted to commit files outside its scope:`, files);
            res.writeHead(403, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ status: "error", message: "Forbidden: Cannot commit files outside component scope" }));
          }

          if (files.length === 0) files = [componentName];

          const result = await queueGitCommit(files, payload.message);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: "Invalid JSON" }));
        }
      });
      return;
    }

    if (path === "/_forest/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }


    if (path === "/_forest/reload" && req.method === "POST") {
      const token = req.headers['x-forest-token'];

      // Validate: Must match the boot-generated hook token OR the global Git secret
      const isValid = (token === RELOAD_TOKEN) || (GIT_SECRET && timingSafeEqualStr(token, GIT_SECRET));

      if (!isValid) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        return res.end("Forbidden: Invalid reload token");
      }

      console.log("[sync] 🔄 Reload requested via secure token.");
      process.kill(process.pid, 'SIGHUP');
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("Reload triggered");
    }

    if (path === "/_forest/status" && req.method === "GET") {
      const token = req.headers['x-forest-token'];
      const componentName = componentTokens.get(token);

      if (!componentName) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "error", message: "Forbidden: Invalid component token" }));
      }

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
        is_reloading: isReloading,
        requested_by: componentName
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(status, null, 2));
    }

    if (path.startsWith("/git")) return handleGit(req, res, ip);

    const segment = path.split("/")[1];
    if (segment && components.has(segment)) {
      if (path === `/${segment}`) {
        res.writeHead(301, { "Location": `/${segment}/${url.search}` });
        return res.end();
      }
      return proxyToComponent(req, res, segment);
    }

    // 🚀 NEW: Fallback to public/ static server (handles / automatically)
    await serveStatic(req, res);

  } catch (err) {
    console.error("[core] Unhandled error:", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
});

process.on('SIGTERM', () => {
  console.log('[core] ⏹️ Received SIGTERM. Closing HTTP server gracefully...');
  server.close(() => { console.log('[core] ✅ Active connections finished. Exiting.'); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
});

async function freshInit() {
  console.log('[boot] 🌱 Initializing fresh Git repository...');
  try {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: ROOT });
    await execFileAsync('git', ['config', 'user.email', 'forest@local'], { cwd: ROOT });
    await execFileAsync('git', ['config', 'user.name', 'Forest Server'], { cwd: ROOT });
    await execFileAsync('git', ['config', 'receive.denyCurrentBranch', 'updateInstead'], { cwd: ROOT });

    const hooksDir = join(ROOT, '.git', 'hooks');
    if (!existsSync(hooksDir)) await mkdir(hooksDir, { recursive: true });

    const hookPath = join(hooksDir, 'post-receive');

    // 🚀 NEW: Inject the RELOAD_TOKEN into the curl header
    const hookContent = `#!/bin/sh
# Trigger the Forest Core to reload workers after a remote git push
curl -s -X POST -H "x-forest-token: ${RELOAD_TOKEN}" http://localhost:\${FOREST_CORE_PORT:-3000}/_forest/reload > /dev/null 2>&1 || true
`;

    await writeFile(hookPath, hookContent, { mode: 0o755 });

    console.log('[boot] ✅ Git repository initialized, configured, and hooked.');
  } catch (err) {
    console.error('[boot] ⚠️ Failed to initialize Git:', err.message);
  }
}

async function boot() {
  // Self-healing: Clean up stale git locks from previous container crashes
  const lockFiles = ['.git/index.lock', '.git/config.lock', '.git/HEAD.lock'];
  for (const lock of lockFiles) {
    await unlink(join(ROOT, lock)).catch(() => { });
  }

  // 🚀 AUTONOMOUS GIT SETUP & RESTORE
  if (!existsSync(join(ROOT, '.git'))) {
    console.log('[boot] 🌱 No Git repository found.');

    // If a backup URL is provided, try to restore from it first
    if (GITHUB_BACKUP_URL) {
      console.log('[boot] 🔄 Attempting to restore from GitHub backup...');
      try {
        await execFileAsync('git', ['clone', GITHUB_BACKUP_URL, '.'], { cwd: ROOT });
        console.log('[boot] ✅ Successfully restored from backup.');
      } catch (err) {
        console.error('[boot] ⚠️ Clone failed. Falling back to fresh init.', err.message);
        await freshInit();
      }
    } else {
      await freshInit();
    }
  }

  // Mount Components
  const entries = await readdir(ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "public") {
      if (existsSync(join(ROOT, entry.name, "index.js"))) await swapComponent(entry.name);
    }
  }

  // Start Backup Sync
  if (GITHUB_BACKUP_URL) {
    console.log(`[backup] 🔄 GitHub backup enabled. Syncing every 5 minutes.`);
    setTimeout(syncToBackup, 10000);
    setInterval(syncToBackup, 5 * 60 * 1000);
  }

  server.listen(PORT, () => {
    console.log(`[ready] http://localhost:${PORT} | components: ${[...components.keys()].join(", ") || "none"}`);
    console.log(`[security] Git Auth: ${GIT_SECRET ? 'ENABLED (Timing-Safe)' : 'DISABLED'} | Proxy Trust: ${TRUST_PROXY ? 'ON' : 'OFF'}`);
    console.log(`[git] HTTP Backend: ${GIT_HTTP_BACKEND}`);
  });
}

boot();

