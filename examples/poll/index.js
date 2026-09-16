import { createServer } from 'node:http';
import { readFile, appendFile, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process'; // 🚀 Changed from exec
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile); // 🚀 Changed from execAsync
const DIR = process.env.TISSUE_DIR;
const NAME = process.env.TISSUE_NAME;
const VOTES_FILE = join(DIR, 'votes.md');

// The Git repository root is the parent of the component directory
const REPO_ROOT = process.cwd();

// --- SECURE GIT DATA SYNC ---
async function commitData(message) {
  try {
    // 1. Stage the specific file using an array of arguments (No shell injection!)
    // We use the relative path from the repo root: "poll/votes.md"
    await execFileAsync('git', ['add', `${NAME}/votes.md`], { cwd: REPO_ROOT });

    // 2. Check if there are actually staged changes
    const { stdout } = await execFileAsync('git', ['diff', '--staged', '--name-only'], { cwd: REPO_ROOT });

    // 3. Commit only if changes exist (prevents "nothing to commit" errors)
    if (stdout.trim().length > 0) {
      await execFileAsync('git', ['commit', '-m', message], { cwd: REPO_ROOT });
      console.log(`[poll] 💾 Data committed: ${message}`);
    }
  } catch (err) {
    // Log real failures, but don't crash the worker
    console.error('[poll] ⚠️ Git commit failed:', err.message);
  }
}


// --- UTILITIES ---
const escapeHtml = (str) => str.replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[m]));

// --- STORAGE ---
async function initStorage() {
  try {
    await access(VOTES_FILE);
  } catch {
    await writeFile(VOTES_FILE, '# Poll: Is git-forest the future of deployment?\n\n');
    // Commit the initial file creation
    await commitData('chore: initialize poll storage');
  }
}

async function getVotes() {
  try {
    const content = await readFile(VOTES_FILE, 'utf-8');
    const lines = content.split('\n').filter(l => l.startsWith('- Vote:'));
    const yes = lines.filter(l => l.includes('Choice: Yes')).length;
    const no = lines.filter(l => l.includes('Choice: No')).length;
    const recent = lines.slice(-5).reverse();
    return { yes, no, recent };
  } catch {
    return { yes: 0, no: 0, recent: [] };
  }
}

// --- HTML TEMPLATE ---
function renderPoll({ yes, no, recent }) {
  const total = yes + no;
  const yesPct = total ? Math.round((yes / total) * 100) : 0;
  const noPct = total ? Math.round((no / total) * 100) : 0;
  const voteList = recent.length
    ? recent.map(l => `<li>${escapeHtml(l.replace('- Vote: ', ''))}</li>`).join('')
    : '<li>No votes yet. Be the first!</li>';

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Live Poll</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; color: #334155; line-height: 1.5; }
      .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
      .bar-container { background: #e2e8f0; border-radius: 4px; height: 24px; overflow: hidden; display: flex; margin: 0.5rem 0 1rem; }
      .bar-yes { background: #10b981; height: 100%; }
      .bar-no { background: #ef4444; height: 100%; }
      input, select, button { padding: 0.5rem; margin: 0.25rem 0; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 1rem; }
      button { background: #3b82f6; color: white; border: none; cursor: pointer; padding: 0.5rem 1rem; }
      button:hover { background: #2563eb; }
      ul { padding-left: 1.2rem; font-size: 0.875rem; color: #64748b; }
    </style>
  </head>
  <body>
    <h1>🗳️ Live Poll</h1>
    <div class="card">
      <h2 style="margin-top:0;">Is git-forest the future of deployment?</h2>
      <div class="bar-container">
        <div class="bar-yes" style="width: ${yesPct}%" title="Yes: ${yes}"></div>
        <div class="bar-no" style="width: ${noPct}%" title="No: ${no}"></div>
      </div>
      <p><strong>Yes:</strong> ${yes} (${yesPct}%) &nbsp;|&nbsp; <strong>No:</strong> ${no} (${noPct}%)</p>
      <form action="./vote" method="POST" style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem;">
        <input type="text" name="name" placeholder="Your name" required style="flex: 1;">
        <select name="choice" required>
          <option value="Yes">Yes 🚀</option>
          <option value="No">No 🤔</option>
        </select>
        <button type="submit">Vote</button>
      </form>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Recent Votes</h3>
      <ul>${voteList}</ul>
      <p style="font-size: 0.75rem; color: #94a3b8;">Stored as raw Markdown in <code>poll/votes.md</code>. Auto-committed to Git.</p>
    </div>
    <p><a href="/" style="color: #3b82f6;">← Back to Dashboard</a></p>
  </body>
  </html>`;
}

// --- HTTP SERVER ---
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    const votes = await getVotes();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPoll(votes));
    return;
  }

  if (req.method === 'POST' && req.url === '/vote') {
    let body = ''
    req.on('data', chunk => { body += chunk; });

    req.on('end', async () => {
      try {
        const params = new URLSearchParams(body);
        const name = params.get('name')?.trim() || 'Anonymous';
        const choice = params.get('choice');

        if (choice === 'Yes' || choice === 'No') {
          const timestamp = new Date().toISOString();
          const line = `- Vote: Choice: ${choice} | User: ${name} | Time: ${timestamp}`;

          // 1. Append to file
          await appendFile(VOTES_FILE, line + '\n');

          // 2. Auto-commit to Git
          await commitData(`data: ${name} voted ${choice}`);
        }
      } catch (err) {
        console.error('[poll] Error processing vote:', err);
      }

      res.writeHead(303, { 'Location': '.' });
      res.end();
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// --- GIT-FOREST LIFECYCLE ---
process.on('SIGTERM', () => {
  console.log('[poll] ⏹️ Received SIGTERM, closing gracefully...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

initStorage().then(() => {
  server.listen(process.env.SOCKET_PATH, () => {
    if (process.send) process.send('ready');
    console.log('[poll] 🌱 Ready and listening');
  });
});