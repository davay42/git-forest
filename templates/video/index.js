// video/index.js
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, readdir, rename, unlink, open, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { parse, render } from '../public/mdld-parse.js';

const COMPONENT_DIR = process.env.COMPONENT_DIR;
const COMPONENT_NAME = process.env.COMPONENT_NAME;
const VIDEOS_DIR = join(COMPONENT_DIR, 'videos');
const UPLOADS_DIR = join(COMPONENT_DIR, 'uploads'); // temp session dirs
const LIBRARY_FILE = join(COMPONENT_DIR, 'library.md');

// No hardcoded fallback: an unset VIDEO_SIGN_SECRET means per-boot random keys,
// so stream tokens can never be forged from a known default.
const SIGN_SECRET = process.env.VIDEO_SIGN_SECRET || randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB per chunk
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h stale sweep

const MIME = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v'
};

const VIDEO_BASE = 'tag:example.org,2026:video/';
const LIBRARY_NODE = `${VIDEO_BASE}library`;
const HAS_ADMIN_PRED = `${VIDEO_BASE}hasAdmin`;
const VIDEO_CLASS = `${VIDEO_BASE}Video`;

const LIBRARY_PREFIX = `[video] <${VIDEO_BASE}>

# Video Library {=video:library .prov:Collection label}
`;

// ─── Signed URL Utilities ──────────────────────────────────────────────
function signVideoUrl(videoHash) {
  const expires = Date.now() + TOKEN_TTL_MS;
  const signature = createHmac('sha256', SIGN_SECRET)
    .update(`${videoHash}.${expires}`)
    .digest('hex')
    .slice(0, 16);
  return `${videoHash}.${expires}.${signature}`;
}

function verifyVideoToken(token) {
  if (!token) return null;
  const [videoHash, expires, signature] = token.split('.');
  if (!videoHash || !expires || !signature) return null;
  if (Date.now() > parseInt(expires)) return null;

  const expected = createHmac('sha256', SIGN_SECRET)
    .update(`${videoHash}.${expires}`)
    .digest('hex')
    .slice(0, 16);

  return signature === expected ? videoHash : null;
}

// ─── Admin Utilities ───────────────────────────────────────────────────
function getAdmins(libraryContent) {
  try {
    const { quads } = parse({ text: libraryContent });
    const libraryNode = LIBRARY_NODE;
    const hasAdminPred = HAS_ADMIN_PRED;
    return quads
      .filter(q => q.subject.value === libraryNode && q.predicate.value === hasAdminPred)
      .map(q => q.object.value.split('/').pop());
  } catch {
    return [];
  }
}

async function requireAdmin(req, res) {
  const userId = req.headers['x-forest-user-id'];
  if (!userId) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Authentication required');
    return null;
  }
  const library = await loadLibrary();
  const admins = getAdmins(library);
  if (!admins.includes(userId)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Admin access required');
    return null;
  }
  return userId;
}

// ─── Hash Utilities ────────────────────────────────────────────────────
async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').slice(0, 16)));
    stream.on('error', reject);
  });
}

// ─── Library (MD-LD Knowledge) ─────────────────────────────────────────
async function loadLibrary() {
  try { return await readFile(LIBRARY_FILE, 'utf8'); }
  catch { return LIBRARY_PREFIX; }
}
async function saveLibrary(content) {
  await writeFile(LIBRARY_FILE, content);
}

function parseLibrary(content) {
  try {
    const result = parse({ text: content });
    const videos = [];
    const videoIRIs = new Set();
    for (const q of result.quads) {
      if (q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
        q.object.value === VIDEO_CLASS) {
        videoIRIs.add(q.subject.value);
      }
    }
    for (const iri of videoIRIs) {
      const video = { iri };
      for (const q of result.quads) {
        if (q.subject.value !== iri) continue;
        const prop = q.predicate.value.split(/[#/]/).pop();
        video[prop] = q.object.value;
      }
      videos.push(video);
    }
    return videos;
  } catch (err) {
    console.error('[video] Parse error:', err.message);
    return [];
  }
}

// ─── Librarian: Reconcile filesystem with knowledge graph ──────────────
async function runLibrarian() {
  console.log('[video] 📚 Librarian scanning videos/...');
  const files = await readdir(VIDEOS_DIR).catch(() => []);
  const library = await loadLibrary();
  const videos = parseLibrary(library);
  const knownHashes = new Set(videos.map(v => v.hash).filter(Boolean));
  const issues = [];
  const newFiles = [];

  for (const filename of files) {
    const filePath = join(VIDEOS_DIR, filename);
    const stats = await stat(filePath);
    if (!stats.isFile()) continue;
    const hash = await hashFile(filePath);
    const ext = extname(filename).toLowerCase();
    const expectedFilename = `${hash}${ext}`;

    if (filename !== expectedFilename) {
      console.log(`[video] ⚠️  Renaming ${filename} → ${expectedFilename}`);
      await rename(filePath, join(VIDEOS_DIR, expectedFilename));
    }
    if (!knownHashes.has(hash)) {
      console.log(`[video] 🔍 Discovered untracked file: ${expectedFilename}`);
      newFiles.push({ hash, filename: expectedFilename, size: stats.size });
    }
  }

  for (const video of videos) {
    if (!video.hash) continue;
    const ext = extname(video.filename || '.mp4').toLowerCase();
    const expectedFilename = `${video.hash}${ext}`;
    const filePath = join(VIDEOS_DIR, expectedFilename);
    if (!existsSync(filePath)) {
      issues.push({ type: 'missing', hash: video.hash, label: video.label });
      console.log(`[video] ❌ Missing file: ${video.label} (${video.hash})`);
    } else {
      const actualHash = await hashFile(filePath);
      if (actualHash !== video.hash) {
        issues.push({ type: 'corrupted', hash: video.hash, label: video.label });
        console.log(`[video] ⚠️  Corrupted file: ${video.label}`);
      }
    }
  }

  if (newFiles.length > 0) {
    let updatedLibrary = library;
    for (const { hash, filename, size } of newFiles) {
      const sizeMB = (size / 1024 / 1024).toFixed(1);
      const entry = `
## Untitled ${hash.slice(0, 8)} {=video:${hash} .video:Video label}
[${hash}] {video:hash}
[${filename}] {video:filename}
[${sizeMB}MB] {video:fileSize}
[${new Date().toISOString().slice(0, 10)}] {prov:generatedAtTime ^^xsd:date}
[Discovered by librarian] {comment}
`;
      updatedLibrary += entry;
    }
    await saveLibrary(updatedLibrary);
    console.log(`[video] ✅ Added ${newFiles.length} new file(s) to library`);
  }

  console.log(`[video] 📊 Librarian complete: ${files.length} files, ${videos.length} tracked, ${issues.length} issues, ${newFiles.length} added`);
  return { total: files.length, tracked: videos.length, issues, added: newFiles.length };
}

// ─── Stale Upload Cleanup ──────────────────────────────────────────────
async function sweepStaleUploads() {
  if (!existsSync(UPLOADS_DIR)) return;
  const dirs = await readdir(UPLOADS_DIR, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  let cleaned = 0;
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const sessionPath = join(UPLOADS_DIR, entry.name);
    const meta = await stat(sessionPath).catch(() => null);
    if (!meta) continue;
    if (now - meta.mtimeMs > SESSION_MAX_AGE_MS) {
      console.log(`[video] 🧹 Removing stale upload session: ${entry.name}`);
      await rm(sessionPath, { recursive: true, force: true });
      cleaned++;
    }
  }
  if (cleaned) console.log(`[video] ✅ Cleaned ${cleaned} stale session(s)`);
}

// ─── Chunked Upload Handlers ───────────────────────────────────────────

// POST /upload/start — create a session, return { uploadId, chunksReceived }
async function handleUploadStart(req, res) {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      const { size, chunksCount, filename, fingerprint } = JSON.parse(body);
      if (!size || !chunksCount || !filename) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing size/chunksCount/filename' }));
      }

      const uploadId = randomBytes(8).toString('hex');
      const sessionDir = join(UPLOADS_DIR, uploadId);
      await mkdir(sessionDir, { recursive: true });

      // Save session metadata
      const meta = {
        uploadId,
        adminId,
        filename,
        size,
        chunksCount,
        fingerprint: fingerprint || null,
        createdAt: new Date().toISOString(),
        chunksReceived: []
      };
      await writeFile(join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));

      console.log(`[video] 📦 Started upload session ${uploadId} (${size} bytes, ${chunksCount} chunks)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ uploadId, chunksReceived: [], chunkSize: CHUNK_SIZE }));
    } catch (err) {
      console.error('[video] /upload/start error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to start upload' }));
    }
  });
}

// POST /upload/:id/chunk — receive one chunk (with X-Chunk-Index header)
async function handleUploadChunk(req, res, uploadId, chunkIndex) {
  const sessionDir = join(UPLOADS_DIR, uploadId);
  const metaPath = join(sessionDir, 'meta.json');

  if (!existsSync(metaPath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Session not found' }));
  }

  // Same gate as status/complete: admin AND session owner
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  if (meta.adminId !== adminId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not your session' }));
  }
  if (chunkIndex < 0 || chunkIndex >= meta.chunksCount) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Chunk index out of range' }));
  }

  const chunkPath = join(sessionDir, `chunk-${String(chunkIndex).padStart(6, '0')}`);

  try {
    // Stream the chunk body directly to disk
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(chunkPath);
      req.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      req.on('error', reject);
    });
    if (!meta.chunksReceived.includes(chunkIndex)) {
      meta.chunksReceived.push(chunkIndex);
      meta.chunksReceived.sort((a, b) => a - b);
      await writeFile(metaPath, JSON.stringify(meta, null, 2));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, index: chunkIndex }));
  } catch (err) {
    console.error(`[video] Chunk ${chunkIndex} of ${uploadId} failed:`, err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Chunk write failed' }));
  }
}

// GET /upload/:id/status — query which chunks are received (for resume)
async function handleUploadStatus(req, res, uploadId) {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const metaPath = join(UPLOADS_DIR, uploadId, 'meta.json');
  if (!existsSync(metaPath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Session not found' }));
  }

  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  if (meta.adminId !== adminId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not your session' }));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    uploadId,
    chunksReceived: meta.chunksReceived,
    chunksCount: meta.chunksCount,
    size: meta.size,
    filename: meta.filename
  }));
}

// POST /upload/:id/complete — concat chunks, verify, move to library
async function handleUploadComplete(req, res, uploadId) {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const sessionDir = join(UPLOADS_DIR, uploadId);
  const metaPath = join(sessionDir, 'meta.json');

  if (!existsSync(metaPath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Session not found' }));
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      const { title, description, hash: clientHash } = JSON.parse(body);
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));

      if (meta.adminId !== adminId) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not your session' }));
      }

      // Verify all chunks received
      const missing = [];
      for (let i = 0; i < meta.chunksCount; i++) {
        if (!meta.chunksReceived.includes(i)) missing.push(i);
      }
      if (missing.length > 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing chunks', missing }));
      }

      // Concatenate chunks into temp file
      const ext = extname(meta.filename).toLowerCase() || '.mp4';
      const tempPath = join(VIDEOS_DIR, `temp-${uploadId}${ext}`);
      const out = await open(tempPath, 'w');
      const fileHash = createHash('sha256');

      for (let i = 0; i < meta.chunksCount; i++) {
        const chunkPath = join(sessionDir, `chunk-${String(i).padStart(6, '0')}`);
        const data = await readFile(chunkPath);
        await out.write(data);
        fileHash.update(data);
      }
      await out.close();

      const finalHash = fileHash.digest('hex').slice(0, 16);

      // If client provided a hash, verify
      if (clientHash && clientHash !== finalHash) {
        await unlink(tempPath);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'Hash mismatch',
          expected: clientHash,
          actual: finalHash
        }));
      }

      // Stats
      const stats = await stat(tempPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      const finalFilename = `${finalHash}${ext}`;
      const finalPath = join(VIDEOS_DIR, finalFilename);

      // Dedup: if file already exists with same hash, discard
      if (existsSync(finalPath)) {
        await unlink(tempPath);
        console.log(`[video] ♻️  Duplicate file: ${finalHash}`);
      } else {
        await rename(tempPath, finalPath);
      }

      // Clean up session dir
      await rm(sessionDir, { recursive: true, force: true });

      // Add to library
      const videoTitle = title || meta.filename.replace(/\.[^.]+$/, '');
      const entry = `
## ${videoTitle} {=video:${finalHash} .video:Video label}
[${finalHash}] {video:hash}
[${finalFilename}] {video:filename}
[${sizeMB}MB] {video:fileSize}
[${new Date().toISOString().slice(0, 10)}] {prov:generatedAtTime ^^xsd:date}
${description ? `[${description}] {comment}\n` : ''}`;

      const library = await loadLibrary();
      await saveLibrary(library + entry);

      console.log(`[video] ✅ Complete: ${videoTitle} (${sizeMB}MB, hash=${finalHash})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        hash: finalHash,
        title: videoTitle,
        size: `${sizeMB}MB`
      }));
    } catch (err) {
      console.error('[video] /upload/complete error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// ─── Serve Video with Range Requests & Signed URL Validation ───────────
async function serveVideo(req, res, videoId) {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Signed URL required');
  }
  const verifiedHash = verifyVideoToken(token);
  if (!verifiedHash || verifiedHash !== videoId) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Invalid or expired token');
  }

  const library = await loadLibrary();
  const videos = parseLibrary(library);
  const video = videos.find(v => v.hash === videoId);
  if (!video) { res.writeHead(404); return res.end('Video not found'); }

  const ext = extname(video.filename || '.mp4').toLowerCase();
  const filePath = join(VIDEOS_DIR, `${video.hash}${ext}`);
  if (!existsSync(filePath)) { res.writeHead(404); return res.end('Video file missing'); }

  const stats = await stat(filePath);
  const mimeType = MIME[ext] || 'video/mp4';
  const range = req.headers.range;
  const etag = `"${video.hash}-${stats.size}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'ETag': etag });
    return res.end();
  }

  res.setHeader('ETag', etag);
  res.setHeader('Connection', 'keep-alive');

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
    if (start >= stats.size || end >= stats.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stats.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stats.size,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    createReadStream(filePath).pipe(res);
  }
}

// ─── Thumbnail System ──────────────────────────────────────────────────────
function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  }[c]));
}

function generateFallbackSVG(video) {
  const label = (video.label || 'Untitled').slice(0, 60);
  const comment = (video.comment || '').slice(0, 120);
  const hash = (video.hash || '').slice(0, 8);
  const hue = parseInt(video.hash?.slice(0, 4), 16) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 40%, 15%)"/>
      <stop offset="100%" stop-color="hsl(${hue + 40}, 30%, 8%)"/>
    </linearGradient></defs>
    <rect width="1280" height="720" fill="url(#bg)"/>
    <text x="640" y="120" text-anchor="middle" fill="#e2e8f0" font-family="system-ui" font-size="48" font-weight="600">${escapeXml(label)}</text>
    ${comment ? `<text x="640" y="200" text-anchor="middle" fill="#94a3b8" font-family="system-ui" font-size="28">${escapeXml(comment)}</text>` : ''}
    <text x="640" y="700" text-anchor="middle" fill="#64748b" font-family="monospace" font-size="20">${hash}</text>
  </svg>`;
}

// ─── HTML Pages ────────────────────────────────────────────────────────
function renderUploadPage() {
  const BASE = `/${COMPONENT_NAME}`; // e.g. "/video"

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>📤 Upload Video</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/styles.css">
  <style>
    .upload-form { max-width: 560px; margin: 0 auto; }
    .file-info { margin: 1rem 0; padding: 0.75rem; background: var(--surface); border-radius: 8px; font-size: 0.9rem; color: var(--fg-muted); }
    .chunk-log { margin-top: 1rem; max-height: 120px; overflow-y: auto; font-family: var(--font-mono); font-size: 0.75rem; color: var(--fg-muted); padding: 0.5rem; background: var(--surface-2); border-radius: 6px; }
    .resume-badge { display: inline-block; background: var(--accent-2); color: var(--accent-2-fg); font-size: 0.7rem; padding: 0.15rem 0.5rem; border-radius: 999px; margin-left: 0.5rem; vertical-align: middle; }
  </style>
</head>
<body class="component-page">
  <main>
    <div class="upload-form">
      <a href="../">← Back to Library</a>
      <h1>📤 Upload Video</h1>
      <p style="color: var(--fg-muted); font-size: 0.9rem;">
        Files are uploaded in 2MB chunks with resume support. If the connection drops, reloading this page will continue from where it left off.
      </p>

      <label style="display:block; margin-bottom:0.5rem;">Title</label>
      <input type="text" id="video-title" placeholder="Video title" required>

      <label style="display:block; margin-top:1rem; margin-bottom:0.5rem;">Description (optional)</label>
      <textarea id="video-description" placeholder="Description"></textarea>

      <label style="display:block; margin-top:1rem; margin-bottom:0.5rem;">Video file</label>
      <input type="file" id="video-file" accept="video/*,.tar.gz,.zip" required>

      <div id="file-info" class="file-info" style="display:none;"></div>

      <div class="progress" id="progress" style="display:none; margin-top:1.5rem;">
        <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
        <div id="progress-text" style="font-size: 0.85rem; margin-top: 0.5rem; color: var(--fg-muted);"></div>
      </div>

      <div id="chunk-log" class="chunk-log" style="display:none;"></div>

      <button id="upload-btn" style="margin-top:1.5rem;">Upload</button>
      <div class="status" id="status" style="display:none; margin-top:1rem;"></div>
    </div>
  </main>
  <script>
    const CHUNK_SIZE = ${CHUNK_SIZE};
    const LS_KEY = 'forest:video:upload';
    const MAX_RETRIES = 5;
    const BASE = '${BASE}';  // e.g. "/video" — all API calls are relative to this

    const btn = document.getElementById('upload-btn');
    const progress = document.getElementById('progress');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const chunkLog = document.getElementById('chunk-log');
    const status = document.getElementById('status');
    const fileInfo = document.getElementById('file-info');
    const fileInput = document.getElementById('video-file');

    function log(msg) {
      chunkLog.style.display = 'block';
      const line = document.createElement('div');
      line.textContent = \`[\${new Date().toLocaleTimeString()}] \${msg}\`;
      chunkLog.appendChild(line);
      chunkLog.scrollTop = chunkLog.scrollHeight;
    }

    async function sha256File(file) {
      const head = await file.slice(0, 1024 * 1024).arrayBuffer();
      const tail = await file.slice(Math.max(0, file.size - 1024 * 1024)).arrayBuffer();
      const headHash = await crypto.subtle.digest('SHA-256', head);
      const tailHash = await crypto.subtle.digest('SHA-256', tail);
      const headHex = Array.from(new Uint8Array(headHash)).map(b => b.toString(16).padStart(2,'0')).join('');
      const tailHex = Array.from(new Uint8Array(tailHash)).map(b => b.toString(16).padStart(2,'0')).join('');
      return headHex.slice(0, 16) + tailHex.slice(0, 16);
    }

    function saveState(state) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
    }
    function loadState() {
      try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
    }
    function clearState() {
      try { localStorage.removeItem(LS_KEY); } catch {}
    }

    async function tryRequest(url, opts, retries = MAX_RETRIES) {
      const fullUrl = BASE + url;  // prefix with component base
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const res = await fetch(fullUrl, opts);
          if (!res.ok) {
            const text = await res.text();
            if (attempt === retries) throw new Error(\`HTTP \${res.status}: \${text}\`);
            log(\`⚠️ Retry \${attempt}/\${retries} for \${url}\`);
            await new Promise(r => setTimeout(r, attempt * 1000));
            continue;
          }
          return res;
        } catch (err) {
          if (attempt === retries) throw err;
          log(\`⚠️ Network error, retry \${attempt}/\${retries}: \${err.message}\`);
          await new Promise(r => setTimeout(r, attempt * 1000));
        }
      }
    }

    async function uploadFile(file) {
      btn.disabled = true;
      progress.style.display = 'block';
      status.style.display = 'none';

      const title = document.getElementById('video-title').value.trim();
      const description = document.getElementById('video-description').value.trim();
      if (!title) throw new Error('Title is required');

      const chunksCount = Math.ceil(file.size / CHUNK_SIZE);
      log(\`Preparing: \${file.name} (\${(file.size / 1024 / 1024).toFixed(1)}MB, \${chunksCount} chunks)\`);

      const saved = loadState();
      let uploadId = null;
      let chunksReceived = [];
      let fingerprint = null;

      if (saved && saved.filename === file.name && saved.size === file.size) {
        fingerprint = saved.fingerprint;
        log(\`🔄 Found previous session, checking resume status...\`);
        try {
          const stRes = await tryRequest(\`/upload/\${saved.uploadId}/status\`);
          const stData = await stRes.json();
          uploadId = stData.uploadId;
          chunksReceived = stData.chunksReceived || [];
          log(\`✓ Resuming: \${chunksReceived.length}/\${chunksCount} chunks already uploaded\`);
          if (chunksReceived.length > 0) {
            progressText.innerHTML = \`Resuming... <span class="resume-badge">RESUME</span>\`;
          }
        } catch (err) {
          log(\`⚠️ Previous session expired, starting fresh\`);
          uploadId = null;
          chunksReceived = [];
        }
      }

      if (!uploadId) {
        fingerprint = await sha256File(file);
        log(\`📦 Starting new upload session...\`);
        const startRes = await tryRequest('/upload/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ size: file.size, chunksCount, filename: file.name, fingerprint })
        });
        const startData = await startRes.json();
        uploadId = startData.uploadId;
        chunksReceived = startData.chunksReceived || [];
        saveState({ uploadId, filename: file.name, size: file.size, fingerprint, title, description });
      }

      let uploadedBytes = chunksReceived.length * CHUNK_SIZE;
      for (let i = 0; i < chunksCount; i++) {
        if (chunksReceived.includes(i)) {
          uploadedBytes = Math.min(file.size, uploadedBytes + CHUNK_SIZE);
          continue;
        }

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        log(\`📤 Chunk \${i + 1}/\${chunksCount} (\${((end - start) / 1024 / 1024).toFixed(2)}MB)\`);

        await tryRequest(\`/upload/\${uploadId}/chunk\`, {
          method: 'POST',
          headers: { 'X-Chunk-Index': String(i) },
          body: chunk
        });

        uploadedBytes += (end - start);
        const pct = Math.round((uploadedBytes / file.size) * 100);
        progressFill.style.width = pct + '%';
        progressText.textContent = \`\${pct}% — \${(uploadedBytes / 1024 / 1024).toFixed(1)}MB / \${(file.size / 1024 / 1024).toFixed(1)}MB\`;
      }

      log(\`🏁 Finalizing...\`);
      progressText.textContent = 'Finalizing...';
      const completeRes = await tryRequest(\`/upload/\${uploadId}/complete\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description })
      });
      const completeData = await completeRes.json();

      clearState();
      status.textContent = \`✅ Uploaded! Hash: \${completeData.hash} (\${completeData.size})\`;
      status.className = 'status success';
      status.style.display = 'block';
      progressFill.style.width = '100%';
      progressText.textContent = 'Complete';

      setTimeout(() => window.location.href = '../', 1500);
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) { fileInfo.style.display = 'none'; return; }
      const chunks = Math.ceil(file.size / CHUNK_SIZE);
      fileInfo.style.display = 'block';
      fileInfo.innerHTML = \`<strong>\${file.name}</strong><br>
        \${(file.size / 1024 / 1024).toFixed(2)} MB · \${chunks} chunks of 2 MB\`;
    });

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      status.style.display = 'none';
      try {
        await uploadFile(fileInput.files[0]);
      } catch (err) {
        console.error(err);
        status.textContent = \`❌ \${err.message}\`;
        status.className = 'status error';
        status.style.display = 'block';
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function renderLibraryPage(libraryContent, isAdmin) {
  let renderedHTML = '';
  try { renderedHTML = render(libraryContent); }
  catch (err) {
    console.error('[video] Render error:', err.message);
    renderedHTML = '<p style="color:#f87171;">Render failed</p>';
  }

  const videos = parseLibrary(libraryContent);
  videos.sort((a, b) => (b.generatedAtTime || '').localeCompare(a.generatedAtTime || ''));

  const videoCards = videos.map(v => `
    <div class="video-card">
      <a href="./watch/${v.hash}">
        <h3>▶️ ${v.label || 'Untitled'}</h3>
        <div class="video-meta">${v.fileSize || ''} • ${v.generatedAtTime || ''}</div>
        <div class="video-hash">${v.hash || 'no hash'}</div>
        ${v.comment ? `<div class="video-desc">${v.comment}</div>` : ''}
      </a>
    </div>
  `).join('');

  const uploadButton = isAdmin
    ? '<a href="./upload/" class="upload-link">📤 Upload</a>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🎬 Video Library</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/styles.css">
  <style>
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
    .empty { color: var(--fg-muted); font-style: italic; }
    .count { color: var(--fg-muted); font-size: 0.9rem; margin-bottom: 1.5rem; }
    details { margin-top: 3rem; padding: 1.5rem; background: var(--surface); border-radius: 12px; }
    summary { cursor: pointer; color: var(--fg-muted); }
  </style>
</head>
<body class="component-page">
  <main>
    <div class="header">
      <h1>🎬 Video Library</h1>
      ${uploadButton}
    </div>
    <div class="count">${videos.length} video${videos.length !== 1 ? 's' : ''}</div>
    ${videos.length === 0
      ? '<p class="empty">No videos yet. Upload your first one!</p>'
      : `<div class="video-grid">${videoCards}</div>`
    }
    <details>
      <summary>View Raw Library (MD-LD)</summary>
      <div style="margin-top:1rem; font-size:0.85rem; line-height:1.6;">${renderedHTML}</div>
    </details>
  </main>
</body>
</html>`;
}

function renderPlayerPage(videoHash, video) {
  const token = signVideoUrl(videoHash);
  const ext = extname(video.filename || '').toLowerCase();
  const downloadName = `${video.label || 'video'}${ext}`;
  const mimeType = MIME[ext] || 'video/mp4';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${video.label || 'Video'}</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/styles.css">
  <style>
    .player-container { max-width: 900px; margin: 0 auto; }
    video { width: 100%; border-radius: 12px; background: #000; }
    h1 { margin: 1rem 0 0.5rem; }
    .meta { color: var(--fg-muted); font-size: 0.9rem; }
    .hash { color: var(--fg-muted); font-family: var(--font-mono); font-size: 0.85rem; margin-top: 0.25rem; }
    .desc { color: #cbd5e1; margin-top: 0.75rem; line-height: 1.5; }
    .actions { margin-top: 1.5rem; display: flex; gap: 1rem; }
  </style>
</head>
<body class="component-page">
  <div class="player-container">
    <a href="../">← Back to Library</a>
    <video controls autoplay playsinline>
      <source src="../stream/${videoHash}?token=${token}" type="${mimeType}">
    </video>
    <h1>${video.label || 'Untitled'}</h1>
    <div class="meta">${video.fileSize || ''} • ${video.generatedAtTime || ''}</div>
    <div class="hash">hash: ${videoHash}</div>
    ${video.comment ? `<div class="desc">${video.comment}</div>` : ''}
    <div class="actions">
      <a href="../stream/${videoHash}?token=${token}" download="${downloadName}" class="download-link">⬇️ Download</a>
    </div>
    <div class="token-info">
      <strong>Signed URL:</strong> This video stream is protected with a time-limited token that expires in 4 hours.
    </div>
  </div>
</body>
</html>`;
}

function renderEmbedPage(videoHash, video) {
  const token = signVideoUrl(videoHash);
  const ext = extname(video.filename || '').toLowerCase();
  const mimeType = MIME[ext] || 'video/mp4';
  const thumbnail = video.thumbnail;
  const posterSrc = thumbnail ||
    `data:image/svg+xml;utf8,${encodeURIComponent(generateFallbackSVG(video))}`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/styles.css">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #000; overflow: hidden; width: 100vw; height: 100vh; }
  .poster { width: 100%; height: 100vh; background: #000 center/cover no-repeat;
    cursor: pointer; position: relative; display: flex; align-items: center; justify-content: center; }
  .poster::after { content: ''; position: absolute; inset: 0;
    background: linear-gradient(180deg, transparent 60%, rgba(0,0,0,0.7)); pointer-events: none; }
  .play-btn { width: 80px; height: 80px; background: rgba(74, 222, 128, 0.95);
    border-radius: 50%; display: flex; align-items: center; justify-content: center;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5); z-index: 2;
    transition: transform 0.15s, background 0.15s; }
  .poster:hover .play-btn { transform: scale(1.1); background: rgba(74, 222, 128, 1); }
  .play-btn::before { content: ''; width: 0; height: 0;
    border-left: 26px solid #0f172a; border-top: 18px solid transparent;
    border-bottom: 18px solid transparent; margin-left: 6px; }
  video { width: 100%; height: 100%; object-fit: contain; }
</style></head>
<body>
  <div class="poster" id="poster" style="background-image: url('${posterSrc}')">
    <div class="play-btn"></div>
  </div>
  <script>
    const poster = document.getElementById('poster');
    const videoSrc = '../stream/${videoHash}?token=${token}';
    const mimeType = '${mimeType}';
    poster.addEventListener('click', () => {
      const video = document.createElement('video');
      video.src = videoSrc;
      video.type = mimeType;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.style.cssText = 'width:100%;height:100vh;object-fit:contain;background:#000;';
      document.body.innerHTML = '';
      document.body.appendChild(video);
    });
  </script>
</body></html>`;
}

// ─── HTTP Server ───────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    // Upload routes (admin-only)
    if ((path === '/upload' || path === '/upload/') && req.method === 'GET') {
      const adminId = await requireAdmin(req, res);
      if (!adminId) return;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderUploadPage());
    }

    if (path === '/upload/start' && req.method === 'POST') {
      return await handleUploadStart(req, res);
    }

    if (path === '/upload/complete' && req.method === 'POST') {
      // Note: this won't match because uploadId is in path. See below.
    }

    const chunkMatch = path.match(/^\/upload\/([a-f0-9]+)\/chunk$/);
    if (chunkMatch && req.method === 'POST') {
      const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);
      if (isNaN(chunkIndex)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing X-Chunk-Index header' }));
      }
      return await handleUploadChunk(req, res, chunkMatch[1], chunkIndex);
    }

    const statusMatch = path.match(/^\/upload\/([a-f0-9]+)\/status$/);
    if (statusMatch && req.method === 'GET') {
      return await handleUploadStatus(req, res, statusMatch[1]);
    }

    const completeMatch = path.match(/^\/upload\/([a-f0-9]+)\/complete$/);
    if (completeMatch && req.method === 'POST') {
      return await handleUploadComplete(req, res, completeMatch[1]);
    }

    // Stream route (signed URL required)
    const streamMatch = path.match(/^\/stream\/(.+)$/);
    if (streamMatch && req.method === 'GET') {
      return serveVideo(req, res, streamMatch[1]);
    }

    // Watch route (public, generates signed URL)
    const watchMatch = path.match(/^\/watch\/(.+)$/);
    if (watchMatch && req.method === 'GET') {
      const library = await loadLibrary();
      const videos = parseLibrary(library);
      const video = videos.find(v => v.hash === watchMatch[1]);
      if (!video) { res.writeHead(404); return res.end('Video not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderPlayerPage(watchMatch[1], video));
    }

    const embedMatch = path.match(/^\/embed\/(.+)$/);
    if (embedMatch && req.method === 'GET') {
      const library = await loadLibrary();
      const videos = parseLibrary(library);
      const video = videos.find(v => v.hash === embedMatch[1]);
      if (!video) { res.writeHead(404); return res.end('Video not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderEmbedPage(embedMatch[1], video));
    }

    // Library page (public, shows upload button if admin)
    if ((path === '/' || path === '') && req.method === 'GET') {
      const library = await loadLibrary();
      const userId = req.headers['x-forest-user-id'];
      const admins = getAdmins(library);
      const isAdmin = userId && admins.includes(userId);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderLibraryPage(library, isAdmin));
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    console.error('[video] Server error:', err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  }
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

async function boot() {
  await mkdir(VIDEOS_DIR, { recursive: true });
  await mkdir(UPLOADS_DIR, { recursive: true });

  if (!existsSync(LIBRARY_FILE)) {
    await writeFile(LIBRARY_FILE, LIBRARY_PREFIX);
  }

  await sweepStaleUploads();
  await runLibrarian();

  server.listen(process.env.SOCKET_PATH, () => {
    console.log(`[video] 🎬 Ready (chunked upload with resume, signed URLs)`);
  });
}

boot();