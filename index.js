import { createServer, request, Agent } from "node:http";
import { spawn } from "node:child_process";
import { readdir, readFile, unlink, access } from "node:fs/promises";
import { join, extname } from "node:path";
import { existsSync } from "node:fs";
import crypto from "node:crypto";

const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const GIT_SECRET = process.env.GIT_SECRET;
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".md": "text/markdown", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };

const proxyAgent = new Agent({ keepAlive: true, maxSockets: 128 });
const tissues = new Map();
let isReloading = false;

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
  if (!entry || now > entry.resetAt) {
    authBuckets.set(ip, { count: 1, resetAt: now + 60000 });
    return false;
  }
  entry.count++;
  return entry.count > 5;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authBuckets) if (now > entry.resetAt) authBuckets.delete(ip);
}, 60000).unref();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function addSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

// ─── ZERO-DOWNTIME SWAP LOGIC ──────────────────────────────────────────
async function swapTissue(name) {
  const oldTissue = tissues.get(name);
  const newSocketPath = `/tmp/forest-${name}-${Date.now()}.sock`;
  const scriptPath = join(ROOT, name, "index.js");
  await unlink(newSocketPath).catch(() => { });
  console.log(`[sync] 🌱 Starting new /${name}...`);

  const newProc = spawn("node", [scriptPath], {
    env: { ...process.env, SOCKET_PATH: newSocketPath, TISSUE_NAME: name, TISSUE_DIR: join(ROOT, name) },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  });

  // FIX 4: Stop waiting immediately if the process crashes before sending 'ready'
  await new Promise((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    newProc.once('message', (msg) => { if (msg === 'ready') done(); });
    newProc.once('exit', done);
    setTimeout(done, 2000);
  });

  tissues.set(name, { socketPath: newSocketPath, proc: newProc });
  console.log(`[sync] 🔄 Swapped router for /${name}`);

  if (oldTissue) {
    oldTissue.proc.kill("SIGTERM");
    setTimeout(() => unlink(oldTissue.socketPath).catch(() => { }), 5000);
  }

  newProc.on("exit", (code) => {
    if (code !== 0 && code !== null && tissues.get(name)?.proc === newProc) {
      console.log(`[error] /${name} crashed with code ${code}. Restarting in 3s...`);
      tissues.delete(name);
      setTimeout(() => swapTissue(name), 3000);
    }
  });
}

function killTissue(name) {
  const tissue = tissues.get(name);
  if (tissue) {
    tissue.proc.kill("SIGTERM");
    setTimeout(() => unlink(tissue.socketPath).catch(() => { }), 5000);
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
          await swapTissue(entry.name);
        }
      }
    }
    for (const name of tissues.keys()) {
      if (!newFolders.has(name)) {
        console.log(`[sync] 🗑️ Removing deleted /${name}`);
        killTissue(name);
        tissues.delete(name);
      }
    }
    console.log(`[sync] ✅ Reload complete. Active: ${[...tissues.keys()].join(", ") || "none"}`);
  } catch (err) { console.error("[sync] Reload failed:", err); }
  finally { isReloading = false; }
});

// ─── HTTP HANDLING ─────────────────────────────────────────────────────
async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const filePath = join(ROOT, decodeURIComponent(url.pathname));

  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }

  // FIX 1: Deep Blocklist - Protect sensitive files at ANY depth in the tree
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
    res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"git-forest\"" });
    res.end("Unauthorized");
    return null;
  }
  const base64 = auth.split(" ")[1];
  const credentials = Buffer.from(base64, "base64").toString("utf-8");
  const [user, password] = credentials.split(":");

  if (!password || !timingSafeEqualStr(password, GIT_SECRET)) {
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
  const git = spawn("/usr/libexec/git-core/git-http-backend", [], { env });
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

// FIX 3: Raw URL Proxying to preserve encoding (e.g. %20) and query strings
function proxyToTissue(req, res, segment) {
  const tissue = tissues.get(segment);
  if (!tissue) { res.writeHead(502); return res.end("Component unavailable"); }

  const prefixLength = segment.length + 1;
  let strippedUrl = req.url.slice(prefixLength);
  if (!strippedUrl.startsWith('/')) strippedUrl = '/' + strippedUrl;

  const proxyReq = request({
    agent: proxyAgent, socketPath: tissue.socketPath, path: strippedUrl, method: req.method, headers: req.headers
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

    if (path.startsWith("/git")) return handleGit(req, res, ip);

    if (path === "/" || path === "") {
      req.url = "/index.html";
      return serveStatic(req, res);
    }

    const segment = path.split("/")[1];
    if (segment && tissues.has(segment)) {
      if (path === `/${segment}`) {
        // FIX 2: Preserve query string on trailing slash redirect
        res.writeHead(301, { "Location": `/${segment}/${url.search}` });
        return res.end();
      }
      return proxyToTissue(req, res, segment);
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
  const entries = await readdir(ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      if (existsSync(join(ROOT, entry.name, "index.js"))) await swapTissue(entry.name);
    }
  }
  server.listen(PORT, () => {
    console.log(`[ready] http://localhost:${PORT} | components: ${[...tissues.keys()].join(", ") || "none"}`);
    console.log(`[security] Git Auth: ${GIT_SECRET ? 'ENABLED (Timing-Safe)' : 'DISABLED'}`);
  });
}
boot();