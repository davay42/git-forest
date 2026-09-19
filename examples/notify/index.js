// notify/index.js
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sendWebPush } from './web-push.js';

const COMPONENT_DIR = process.env.COMPONENT_DIR;
const COMPONENT_NAME = process.env.COMPONENT_NAME;
const REPORT_FILE = join(COMPONENT_DIR, 'report.md');
const SUBSCRIPTIONS_FILE = join(COMPONENT_DIR, 'subscriptions.json');

const vapid = {
  publicKey: process.env.VAPID_PUBLIC_KEY || '',
  privateKey: process.env.VAPID_PRIVATE_KEY || '',
  subject: process.env.VAPID_SUBJECT || 'mailto:admin@forest.local'
};

if (!vapid.publicKey || !vapid.privateKey) {
  console.warn('[notify] ⚠️ VAPID keys not set.');
}

// ─── State ─────────────────────────────────────────────────────────────
let counter = 0;
let totalNotifications = 0;
let subscriptions = []; // { endpoint, keys, frequency, subscribedAt }
const sseClients = new Set();

// ─── Forest Commit Helper ──────────────────────────────────────────────
async function commitToForest(files, message) {
  try {
    const res = await fetch(`http://localhost:${process.env.FOREST_CORE_PORT}/_forest/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forest-token': process.env.FOREST_COMPONENT_TOKEN
      },
      body: JSON.stringify({ files, message })
    });
    return res.json();
  } catch (err) {
    console.error('[notify] Commit failed:', err.message);
  }
}

// ─── Knowledge: Report Document ────────────────────────────────────────
async function loadReport() {
  try {
    const content = await readFile(REPORT_FILE, 'utf8');
    const lines = content.split('\n').filter(l => l.startsWith('|') && !l.includes('Count'));
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      const match = lastLine.match(/\|\s*(\d+)/);
      if (match) {
        counter = parseInt(match[1], 10);
        totalNotifications = lines.length;
        console.log(`[notify] 📜 Restored counter=${counter} from report`);
      }
    }
  } catch {
    await writeFile(REPORT_FILE, `# Counter Notifications Log\n\n| Count | Time | Subscribers Notified |\n|-------|------|---------------------|\n`);
  }
}

async function appendReport(notifiedCount) {
  const time = new Date().toISOString();
  const line = `| ${counter} | ${time} | ${notifiedCount} |\n`;
  await appendFile(REPORT_FILE, line);
  await commitToForest(
    [`${COMPONENT_NAME}/report.md`],
    `knowledge: counter ${counter} (notification #${totalNotifications}, ${notifiedCount} recipients)`
  );
}

// ─── Subscriptions ─────────────────────────────────────────────────────
async function loadSubscriptions() {
  try {
    subscriptions = JSON.parse(await readFile(SUBSCRIPTIONS_FILE, 'utf8'));
  } catch {
    subscriptions = [];
  }
}

async function saveSubscriptions() {
  await writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2));
}

// ─── Broadcast (per-subscription frequency) ────────────────────────────
async function broadcast() {
  if (subscriptions.length === 0) return;

  const eligible = subscriptions.filter(sub => counter % sub.frequency === 0);
  if (eligible.length === 0) return;

  let sent = 0;
  const expired = [];

  for (let i = 0; i < eligible.length; i++) {
    const sub = eligible[i];

    // Create unique ID from endpoint (last 32 chars, URL-safe)
    const subId = encodeURIComponent(sub.endpoint.slice(-32));

    const payload = JSON.stringify({
      title: `🌲 Counter: ${counter}`,
      body: `Reached ${counter} clicks. Tap to change notification frequency.`,
      emoji: '🌲',
      badgeEmoji: '🍃',
      url: `./?id=${subId}`
    });

    try {
      await sendWebPush(sub, payload, vapid);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        expired.push(sub.endpoint);
      } else {
        console.error(`[notify] Push error:`, err.message);
      }
    }
  }

  if (expired.length > 0) {
    subscriptions = subscriptions.filter(s => !expired.includes(s.endpoint));
    await saveSubscriptions();
  }

  totalNotifications++;
  console.log(`[notify] 📤 Sent ${sent}/${eligible.length} | counter=${counter}`);
  await appendReport(sent);
}

// ─── SSE Broadcast ─────────────────────────────────────────────────────
function broadcastSSE() {
  const data = JSON.stringify({ counter, subscribers: subscriptions.length, totalNotifications });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// ─── HTML Page ─────────────────────────────────────────────────────────
function renderPage(subId = null) {
  // Find subscription by ID if provided
  let currentSub = null;
  if (subId) {
    currentSub = subscriptions.find(s => s.endpoint.endsWith(decodeURIComponent(subId)));
  }

  const settingsSection = currentSub ? `
    <div class="settings-card">
      <h2>⚙️ Your Notification Settings</h2>
      <p>Current frequency: <strong>Every ${currentSub.frequency} clicks</strong></p>
      <form id="settings-form" class="settings-form">
        <label>
          <input type="radio" name="frequency" value="10" ${currentSub.frequency === 10 ? 'checked' : ''}>
          Every 10 clicks
        </label>
        <label>
          <input type="radio" name="frequency" value="50" ${currentSub.frequency === 50 ? 'checked' : ''}>
          Every 50 clicks
        </label>
        <button type="submit" class="btn-save">Save Changes</button>
      </form>
      <button id="btn-unsubscribe-settings" class="btn-unsubscribe">🔕 Unsubscribe Completely</button>
    </div>
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🌲 Forest Counter</title>
  <link rel="manifest" href="./manifest.json">
  <meta name="theme-color" content="#16a34a">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a; color: #e2e8f0;
      min-height: 100dvh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; padding: 2rem; gap: 1.5rem;
    }
    h1 { font-size: 1.25rem; color: #94a3b8; font-weight: 400; }
    h2 { font-size: 1.1rem; color: #e2e8f0; margin-bottom: 1rem; }
    .counter {
      font-size: clamp(4rem, 15vw, 8rem); font-weight: 800;
      color: #4ade80; font-variant-numeric: tabular-nums;
      text-shadow: 0 0 40px rgba(74, 222, 128, 0.3);
      transition: transform 0.1s;
    }
    .counter.pulse { transform: scale(1.05); }
    .meta { font-size: 0.8rem; color: #64748b; text-align: center; }
    .actions { display: flex; gap: 0.75rem; flex-wrap: wrap; justify-content: center; }
    button {
      padding: 0.875rem 1.5rem; border: none; border-radius: 12px;
      font-size: 1rem; font-weight: 600; cursor: pointer; transition: all 0.15s;
    }
    button:active { transform: scale(0.96); }
    .btn-increment { background: #16a34a; color: white; font-size: 1.25rem; padding: 1rem 2.5rem; }
    .btn-increment:hover { background: #15803d; }
    .btn-subscribe { background: #334155; color: #e2e8f0; }
    .btn-subscribe:hover { background: #475569; }
    .btn-unsubscribe { background: #7f1d1d; color: white; margin-top: 1rem; }
    .btn-unsubscribe:hover { background: #991b1b; }
    .btn-save { background: #2563eb; color: white; margin-top: 1rem; }
    .btn-save:hover { background: #1e40af; }
    .status {
      margin-top: 1rem; font-size: 0.8rem; padding: 0.5rem 1rem;
      border-radius: 99px; background: #1e293b;
    }
    .status.live { color: #4ade80; }
    .status.dead { color: #f87171; }
    .settings-card {
      background: #1e293b; padding: 1.5rem; border-radius: 12px;
      max-width: 400px; width: 100%; margin-top: 2rem;
    }
    .settings-form { display: flex; flex-direction: column; gap: 0.75rem; }
    .settings-form label {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.75rem; background: #0f172a; border-radius: 8px; cursor: pointer;
    }
    .settings-form input[type="radio"] { width: 20px; height: 20px; }
  </style>
</head>
<body>
  <h1>🌲 Forest Counter</h1>
  <div class="counter" id="counter">${counter}</div>
  <div class="meta" id="meta">subscribers: ${subscriptions.length} | sent: ${totalNotifications}</div>
  
  <div class="actions">
    <button class="btn-increment" id="btn-increment">+ Click</button>
    <button class="btn-subscribe" id="btn-subscribe">🔔 Enable Push</button>
  </div>

  <div class="status" id="status">Connecting...</div>

  ${settingsSection}

  <script>
    const counterEl = document.getElementById('counter');
    const metaEl = document.getElementById('meta');
    const statusEl = document.getElementById('status');
    const btnSubscribe = document.getElementById('btn-subscribe');
    let swReg = null;
    const currentSubId = ${subId ? `'${subId}'` : 'null'};

    document.getElementById('btn-increment').addEventListener('click', async () => {
      const res = await fetch('./increment', { method: 'POST' });
      const data = await res.json();
      counterEl.textContent = data.counter;
      counterEl.classList.add('pulse');
      setTimeout(() => counterEl.classList.remove('pulse'), 100);
    });

    btnSubscribe.addEventListener('click', async () => {
      if (!swReg) return alert('Service Worker not ready. Refresh the page.');
      try {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return alert('Notification permission denied.');

        const sub = await swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array('${vapid.publicKey}')
        });

        const res = await fetch('./subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub, frequency: 10 })
        });
        const data = await res.json();
        metaEl.textContent = \`subscribers: \${data.subscribers} | sent: \${data.totalNotifications}\`;
        alert('✅ Subscribed! You\\'ll receive notifications every 10 clicks.');
      } catch (e) {
        console.error(e);
        alert('Subscription failed. Ensure HTTPS and VAPID keys are configured.');
      }
    });

    // Settings form handler
    const settingsForm = document.getElementById('settings-form');
    if (settingsForm) {
      settingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const frequency = parseInt(settingsForm.frequency.value, 10);
        
        try {
          const res = await fetch('./set-frequency', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frequency, id: currentSubId })
          });
          if (res.ok) {
            alert('✅ Settings saved! You\\'ll now receive notifications every ' + frequency + ' clicks.');
            window.location.href = './'; // Redirect to clean URL
          } else {
            alert('❌ Failed to save settings');
          }
        } catch (e) {
          console.error(e);
          alert('❌ Network error');
        }
      });
    }

    // Unsubscribe button in settings
    const btnUnsubscribeSettings = document.getElementById('btn-unsubscribe-settings');
    if (btnUnsubscribeSettings) {
      btnUnsubscribeSettings.addEventListener('click', async () => {
        if (!swReg) return;
        try {
          const sub = await swReg.pushManager.getSubscription();
          if (sub) {
            await sub.unsubscribe();
            await fetch('./unsubscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: currentSubId })
            });
          }
          alert('🔕 Unsubscribed successfully');
          window.location.href = './';
        } catch (e) {
          console.error(e);
          alert('❌ Unsubscribe failed');
        }
      });
    }

    function connectSSE() {
      const es = new EventSource('./events');
      es.onmessage = (e) => {
        const d = JSON.parse(e.data);
        counterEl.textContent = d.counter;
        metaEl.textContent = \`subscribers: \${d.subscribers} | sent: \${d.totalNotifications}\`;
      };
      es.onopen = () => { statusEl.textContent = '🟢 Live'; statusEl.className = 'status live'; };
      es.onerror = () => { statusEl.textContent = '🔴 Reconnecting...'; statusEl.className = 'status dead'; };
    }

    async function registerSW() {
      if ('serviceWorker' in navigator) {
        swReg = await navigator.serviceWorker.register('./sw.js');
      }
    }

    function urlBase64ToUint8Array(b64) {
      const pad = '='.repeat((4 - b64.length % 4) % 4);
      const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
      return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
    }

    registerSW();
    connectSSE();
  </script>
</body>
</html>`;
}

// ─── Service Worker + Manifest ─────────────────────────────────────────
const SW_JS = `
function createEmojiSvg(emoji, bgColor = '#2d4a22') {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="24" fill="' + bgColor + '"/><text x="50" y="55" font-size="60" text-anchor="middle" dominant-baseline="central">' + emoji + '</text></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

const DEFAULT_ICON = createEmojiSvg('🌲', '#2d4a22');
const DEFAULT_BADGE = createEmojiSvg('🍃', '#1b3318');

self.addEventListener('push', (event) => {
  if (!event.data) return;
  const payload = event.data.json();
  const icon = payload.emoji ? createEmojiSvg(payload.emoji) : (payload.icon || DEFAULT_ICON);
  const badge = payload.badgeEmoji ? createEmojiSvg(payload.badgeEmoji, '#1b3318') : (payload.badge || DEFAULT_BADGE);
  
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: icon,
      badge: badge,
      data: payload,
      vibrate: [200, 100, 200]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { data } = event.notification;
  
  if (data.url) {
    const url = data.url.startsWith('http') 
      ? data.url 
      : new URL(data.url, self.registration.scope).href;
    
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        for (const c of list) { 
          if (c.url.includes(self.registration.scope) && 'focus' in c) return c.focus(); 
        }
        if (clients.openWindow) return clients.openWindow(url);
      })
    );
  }
});
`;

const MANIFEST_JSON = JSON.stringify({
  name: 'Forest Counter',
  short_name: 'Forest',
  start_url: './',
  display: 'standalone',
  background_color: '#0f172a',
  theme_color: '#16a34a',
  icons: [{
    src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='24' fill='%232d4a22'/><text x='50' y='55' font-size='60' text-anchor='middle' dominant-baseline='central'>🌲</text></svg>",
    sizes: 'any',
    type: 'image/svg+xml',
    purpose: 'any'
  }]
}, null, 2);

// ─── HTTP Server ───────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const subId = url.searchParams.get('id');

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'GET') {
    if (path === '/' || path === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderPage(subId));
    }
    if (path === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Service-Worker-Allowed': './' });
      return res.end(SW_JS);
    }
    if (path === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(MANIFEST_JSON);
    }
    if (path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`data: ${JSON.stringify({ counter, subscribers: subscriptions.length, totalNotifications })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {

      if (path === '/increment') {
        counter++;
        await broadcast();
        broadcastSSE();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ counter }));
      }

      if (path === '/subscribe') {
        try {
          const { subscription, frequency } = JSON.parse(body);
          const existing = subscriptions.find(s => s.endpoint === subscription.endpoint);
          if (!existing) {
            subscriptions.push({
              endpoint: subscription.endpoint,
              keys: subscription.keys,
              frequency: frequency || 10,
              subscribedAt: new Date().toISOString()
            });
            await saveSubscriptions();
          } else {
            existing.frequency = frequency || existing.frequency;
            await saveSubscriptions();
          }
          broadcastSSE();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'subscribed', subscribers: subscriptions.length, totalNotifications }));
        } catch {
          res.writeHead(400); return res.end('Invalid subscription');
        }
      }

      if (path === '/unsubscribe') {
        try {
          const { id } = JSON.parse(body);
          const decoded = decodeURIComponent(id);
          subscriptions = subscriptions.filter(s => !s.endpoint.endsWith(decoded));
          await saveSubscriptions();
          broadcastSSE();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'unsubscribed', subscribers: subscriptions.length }));
        } catch {
          res.writeHead(400); return res.end('Invalid');
        }
      }

      if (path === '/set-frequency') {
        try {
          const parsed = JSON.parse(body);
          const frequency = parseInt(parsed.frequency, 10);
          const id = decodeURIComponent(parsed.id);

          if (frequency === 10 || frequency === 50) {
            const sub = subscriptions.find(s => s.endpoint.endsWith(id));
            if (sub) {
              const oldFreq = sub.frequency;
              sub.frequency = frequency;
              await saveSubscriptions();
              console.log(`[notify] ✅ Frequency changed: ${oldFreq} → ${frequency}`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ success: true, frequency }));
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Subscription not found' }));
            }
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid frequency' }));
          }
        } catch (err) {
          console.error('[notify] /set-frequency error:', err.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid request' }));
        }
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

async function boot() {
  await mkdir(COMPONENT_DIR, { recursive: true });
  await loadReport();
  await loadSubscriptions();

  server.listen(process.env.SOCKET_PATH, () => {
    if (process.send) process.send('ready');
    console.log(`[notify] 🌲 Ready | counter=${counter} | subs=${subscriptions.length} | VAPID=${vapid.publicKey ? '✓' : '✗'}`);
  });
}

boot();