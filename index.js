import { createServer, request, Agent } from "node:http";
import { spawn, execFile } from "node:child_process";
import { readdir, readFile, unlink, access } from "node:fs/promises";
import { join, extname } from "node:path";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const GIT_SECRET = process.env.GIT_SECRET;
// FIX 3: Only trust X-Forwarded-For if explicitly configured (e.g. behind Traefik/Caddy)
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// ─── GIT HTTP BACKEND DISCOVERY ───────────────────────────────────────────
function discoverGitHttpBackend() {
  // If explicitly set via environment variable, use that
  if (process.env.GIT_HTTP_BACKEND) {
    return process.env.GIT_HTTP_BACKEND;
  }

  // Common locations by platform
  const commonPaths = [
    '/usr/libexec/git-core/git-http-backend',           // Linux/Alpine
    '/usr/local/libexec/git-core/git-http-backend',      // macOS Homebrew (Intel)
    '/opt/homebrew/libexec/git-core/git-http-backend',   // macOS Homebrew (Apple Silicon)
    '/Library/Developer/CommandLineTools/usr/libexec/git-core/git-http-backend', // macOS Xcode CLT
    '/usr/lib/git-core/git-http-backend',               // Some Linux distros
  ];

  for (const path of commonPaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  // Fallback to standard location (will fail if not found, but maintains backward compatibility)
  return '/usr/libexec/git-core/git-http-backend';
}

const GIT_HTTP_BACKEND = discoverGitHttpBackend();

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".md": "text/markdown", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };

const proxyAgent = new Agent({ keepAlive: true, maxSockets: 128 });
const components = new Map();
const componentTokens = new Map(); // Maps secure token -> componentName
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

  // FIX 2: Per-component token for strict commit isolation
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

  // FIX 1: Readiness is an actual signal, not a race
  let ready = false;
  let exitedEarly = false;

  await new Promise((resolve) => {
    const done = () => resolve();
    newProc.once('message', (msg) => { if (msg === 'ready') { ready = true; done(); } });
    newProc.once('exit', (code) => { exitedEarly = true; done(); });
    setTimeout(done, 2000); // 2s timeout for boot
  });

  if (!ready) {
    console.log(`[sync] ❌ /${name} failed to start (ready=${ready}, exited=${exitedEarly}) — keeping previous version live`);
    if (!exitedEarly) newProc.kill("SIGKILL"); // Ensure it's dead if it just timed out
    componentTokens.delete(componentToken);
    return; // Abort swap, old component remains untouched
  }

  // Process is ready and alive. Perform the atomic swap.
  components.set(name, { socketPath: newSocketPath, proc: newProc, token: componentToken, startTime: Date.now() });
  console.log(`[sync] 🔄 Swapped router for /${name}`);

  if (oldComponent) {
    componentTokens.delete(oldComponent.token);
    oldComponent.proc.kill("SIGTERM");
    setTimeout(() => unlink(oldComponent.socketPath).catch(() => { }), 5000);
  }

  // Attach the crash-retry listener ONLY to a process we know is alive and ready
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
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
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
  const filePath = join(ROOT, decodeURIComponent(url.pathname));

  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }

  const relPath = filePath.slice(ROOT.length);
  const blockedNames = ['.git', '.env', '.env.local', '.env.production', 'docker-compose.yml', 'Dockerfile', 'package-lock.json'];
  const parts = relPath.split('/');
  if (parts.some(p => blockedNames.includes(p)) || relPath === '/index.js') {
    res.writeHead(403); return res.end("Forbidden");
  }

  try {
    await access(filePath);
    const content = await readFile(filePath);
    const type = MIME[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    res.end(content);
  } catch { res.writeHead(404); res.end("Not Found"); }
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

// ─── THE GATEWAY ───────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  try {
    addSecurityHeaders(res);
    const url = new URL(req.url, "http://localhost");
    let path = url.pathname;
    const ip = getClientIp(req);

    // 1. Internal Git Commit API (Protected by Per-Component Token)
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
        if (body.length > 1e6) req.destroy(); // 1MB safety limit
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          let files = payload.files || [];
          if (!Array.isArray(files)) files = [files];

          // FIX 2: Validate that all files are strictly within the calling component's directory
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

    // 2. Public Health Endpoint (Simple, safe for external monitoring)
    if (path === "/_forest/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }

    // 3. Internal Forest Status Endpoint (Detailed stats, protected by component token)
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

    if (path === "/" || path === "") {
      req.url = "/index.html";
      return serveStatic(req, res);
    }

    const segment = path.split("/")[1];
    if (segment && components.has(segment)) {
      if (path === `/${segment}`) {
        res.writeHead(301, { "Location": `/${segment}/${url.search}` });
        return res.end();
      }
      return proxyToComponent(req, res, segment);
    }

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

async function boot() {
  // Self-healing: Clean up stale git locks from previous container crashes
  const lockFiles = ['.git/index.lock', '.git/config.lock', '.git/HEAD.lock'];
  for (const lock of lockFiles) {
    await unlink(join(ROOT, lock)).catch(() => { });
  }

  const entries = await readdir(ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      if (existsSync(join(ROOT, entry.name, "index.js"))) await swapComponent(entry.name);
    }
  }
  server.listen(PORT, () => {
    console.log(`[ready] http://localhost:${PORT} | components: ${[...components.keys()].join(", ") || "none"}`);
    console.log(`[security] Git Auth: ${GIT_SECRET ? 'ENABLED (Timing-Safe)' : 'DISABLED'} | Proxy Trust: ${TRUST_PROXY ? 'ON' : 'OFF'}`);
    console.log(`[git] HTTP Backend: ${GIT_HTTP_BACKEND}`);
  });
}
boot();



/*
// Inside your component (e.g., poll/index.js)
async function commitToForest(files, message) {
  try {
    const res = await fetch(`http://localhost:${process.env.FOREST_CORE_PORT}/_forest/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forest-token': process.env.FOREST_COMPONENT_TOKEN // Updated env var
      },
      body: JSON.stringify({ files, message })
    });
    return res.json();
  } catch (err) {
    console.error('[component] Failed to request commit:', err);
  }
}
*/