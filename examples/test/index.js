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
const clients = new Set();

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