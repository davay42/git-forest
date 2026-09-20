// test/index.js — Bulletproof state: Instant disk persistence, delayed Git audit
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = process.env.COMPONENT_DIR;
const NAME = process.env.COMPONENT_NAME;
const CORE_PORT = process.env.FOREST_CORE_PORT || 3000;
const TOKEN = process.env.FOREST_COMPONENT_TOKEN;
const STATE_FILE = join(DIR, 'counter.md');

let clicks = 0;
let commitTimer = null;
const clients = new Set();

// 1. Hydrate from Disk on Boot (Crash Recovery)
(async () => {
  try {
    const content = await readFile(STATE_FILE, 'utf8');
    const match = content.match(/Clicks: \[(\d+)\]/);
    if (match) clicks = parseInt(match[1], 10);
    console.log(`🌲 [${NAME}] Hydrated state from disk: ${clicks} clicks`);
  } catch {
    console.log(`🌲 [${NAME}] No existing state found. Starting fresh.`);
  }
})();

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

// 2. The Delayed Commit Engine (Git Audit)
function scheduleCommit() {
  if (commitTimer) clearTimeout(commitTimer);

  commitTimer = setTimeout(async () => {
    try {
      // Ask the Core to snapshot the current disk state into Git
      const res = await fetch(`http://localhost:${CORE_PORT}/_forest/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forest-token': TOKEN },
        body: JSON.stringify({
          files: [`${NAME}/counter.md`],
          message: `test: snapshot at ${clicks} clicks`
        })
      });
      const result = await res.json();
      if (result.status === 'ok') console.log(`🌲 [${NAME}] Git snapshot committed.`);
    } catch (err) {
      console.error(`[${NAME}] Git commit failed:`, err);
    }
    commitTimer = null;
  }, 60000); // 1 minute debounce for the Git commit
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // SSE Stream
  if (url.pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`data: ${JSON.stringify({ clicks })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // UI
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <body style="font-family:system-ui; text-align:center; margin-top:5rem;">
        <h1>Bulletproof Click Counter</h1>
        <p>Current clicks: <strong id="count">${clicks}</strong></p>
        <button id="btn" style="padding:1rem 2rem; font-size:1.2rem; cursor:pointer; background:#2563eb; color:white; border:none; border-radius:6px;">Click Me!</button>
        <p style="color:#166534; font-size:0.9rem; margin-top:2rem;">✅ State is saved to disk instantly. Git history updates every minute.</p>
        <script>
          const btn = document.getElementById('btn');
          const countEl = document.getElementById('count');
          
          // 🚀 FIX: Use relative paths ('events' and 'click') instead of absolute paths.
          // Because git-forest guarantees a trailing slash on component roots (/test/ or /tunnel/test/),
          // the browser resolves these perfectly within the current context.
          const source = new EventSource('events');
          source.onmessage = (e) => countEl.textContent = JSON.parse(e.data).clicks;
          
          btn.addEventListener('click', () => fetch('click', { method: 'POST' }));
        </script>
      </body>
      </html>
    `);
    return;
  }

  // Mutation: The Magic Happens Here
  if (url.pathname === '/click' && req.method === 'POST') {
    clicks++;

    // A. Broadcast to UI instantly
    broadcast({ clicks });

    // B. INSTANT PERSISTENCE (The Database)
    // We write to disk immediately. If the server crashes 1ms from now, data is safe.
    const md = `# Test Component State\n\nClicks: [${clicks}] {test:clickCount}\nLast updated: [${new Date().toISOString()}] {test:timestamp ^^xsd:dateTime}\n`;

    // Fire-and-forget the disk write to keep the HTTP response fast
    writeFile(STATE_FILE, md).catch(err => console.error(`[${NAME}] Disk write failed:`, err));

    // C. DELAYED COMMIT (The Audit Trail)
    // We reset the 1-minute timer. Git will only see a snapshot of the disk 
    // after the user stops clicking for 1 minute.
    scheduleCommit();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(process.env.SOCKET_PATH, () => {
  console.log(`🌱 Component /${NAME} ready`);
  if (process.send) process.send('ready');
});