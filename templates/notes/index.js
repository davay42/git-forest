// link/index.js
// A minimal demonstration of the Forest Identity Protocol patterns:
// device-first identity, arbitrary directed networks, shared notes,
// and graph-based state management using MD-LD.
// Note: Add `devices.md` and `notes.md` to your .gitignore to keep this state as Soil.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { parse, generate, DataFactory, expandIRI, DEFAULT_CONTEXT } from '../public/mdld-parse.js';

const COMPONENT_DIR = process.env.COMPONENT_DIR;
const DEVICES_FILE = join(COMPONENT_DIR, 'devices.md');
const NOTES_FILE = join(COMPONENT_DIR, 'notes.md');
const SECRET = process.env.AUTH_SECRET || 'forest-link-demo-secret';

const PREFIX = 'tag:school.example.org,2026:link/';
const CONTEXT = { ...DEFAULT_CONTEXT, link: PREFIX, prov: 'http://www.w3.org/ns/prov#' };

const { namedNode, literal, quad } = DataFactory;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const PROV_VALUE = 'http://www.w3.org/ns/prov#value';
const PROV_WAS_GENERATED_BY = 'http://www.w3.org/ns/prov#wasGeneratedBy';
const PROV_GENERATED_AT_TIME = 'http://www.w3.org/ns/prov#generatedAtTime';
const PROV_ENTITY = 'http://www.w3.org/ns/prov#Entity';

// ─── Resilience Utilities ──────────────────────────────────────────────────
const rateLimits = new Map();
const RATE_WINDOW_MS = 60000; // 1 minute
const RATE_MAX_POST = 30;     // 30 mutations (posts) per minute per device

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

// Clean up expired rate limit entries to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(key);
  }
}, RATE_WINDOW_MS).unref();

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Graph Codec ───────────────────────────────────────────────────────────
async function loadGraph(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return parse({ text, context: CONTEXT });
  } catch {
    return { quads: [], context: CONTEXT };
  }
}

async function saveGraph(filePath, quads, context) {
  const { text } = generate({ quads, context });
  await writeFile(filePath, text);
}

function getDevice(quads, deviceId) {
  const deviceIri = expandIRI(`link:device/${deviceId}`, CONTEXT);
  const deviceNode = namedNode(deviceIri);

  const hasType = quads.find(q =>
    q.subject.equals(deviceNode) &&
    q.predicate.value === RDF_TYPE &&
    q.object.value === expandIRI('link:Device', CONTEXT)
  );
  if (!hasType) return null;

  const labelQuad = quads.find(q =>
    q.subject.equals(deviceNode) && q.predicate.value === RDFS_LABEL
  );

  const createdQuad = quads.find(q =>
    q.subject.equals(deviceNode) &&
    q.predicate.value === expandIRI('link:createdAt', CONTEXT)
  );

  const linkedToPred = expandIRI('link:linkedTo', CONTEXT);
  const linkedTo = quads
    .filter(q => q.subject.equals(deviceNode) && q.predicate.value === linkedToPred)
    .map(q => q.object.value.split('/').pop());

  return {
    id: deviceId,
    iri: deviceIri,
    label: labelQuad?.object.value || 'Unnamed',
    createdAt: createdQuad?.object.value,
    linkedTo
  };
}

// Get connected component: all devices reachable via links (both directions)
function getConnectedComponent(deviceQuads, startDeviceId) {
  const visited = new Set();
  const queue = [startDeviceId];
  visited.add(startDeviceId);

  const linkedToPred = expandIRI('link:linkedTo', CONTEXT);

  while (queue.length > 0) {
    const currentId = queue.shift();
    const currentNode = namedNode(expandIRI(`link:device/${currentId}`, CONTEXT));

    // Outbound links
    const outbound = deviceQuads
      .filter(q => q.subject.equals(currentNode) && q.predicate.value === linkedToPred)
      .map(q => q.object.value.split('/').pop());

    // Inbound links
    const inbound = deviceQuads
      .filter(q => q.predicate.value === linkedToPred && q.object.equals(currentNode))
      .map(q => q.subject.value.split('/').pop());

    const neighbors = [...outbound, ...inbound];
    for (const neighborId of neighbors) {
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }
  }

  return Array.from(visited).map(id => getDevice(deviceQuads, id)).filter(Boolean);
}

function addDevice(quads, deviceId, label) {
  const deviceNode = namedNode(expandIRI(`link:device/${deviceId}`, CONTEXT));
  quads.push(
    quad(deviceNode, namedNode(RDF_TYPE), namedNode(expandIRI('link:Device', CONTEXT))),
    quad(deviceNode, namedNode(RDFS_LABEL), literal(label)),
    quad(deviceNode, namedNode(expandIRI('link:createdAt', CONTEXT)), literal(new Date().toISOString()))
  );
}

function linkDevice(quads, childId, parentId) {
  const childNode = namedNode(expandIRI(`link:device/${childId}`, CONTEXT));
  const parentNode = namedNode(expandIRI(`link:device/${parentId}`, CONTEXT));
  const linkedToPred = namedNode(expandIRI('link:linkedTo', CONTEXT));

  const exists = quads.some(q =>
    q.subject.equals(childNode) && q.predicate.equals(linkedToPred) && q.object.equals(parentNode)
  );
  if (!exists) quads.push(quad(childNode, linkedToPred, parentNode));
  return quads;
}

function unlinkDevice(quads, childId, parentId) {
  const childNode = namedNode(expandIRI(`link:device/${childId}`, CONTEXT));
  const parentNode = namedNode(expandIRI(`link:device/${parentId}`, CONTEXT));
  const linkedToPred = namedNode(expandIRI('link:linkedTo', CONTEXT));
  return quads.filter(q =>
    !(q.subject.equals(childNode) && q.predicate.equals(linkedToPred) && q.object.equals(parentNode))
  );
}

// ─── Notes Codec ───────────────────────────────────────────────────────────
function getNote(noteQuads, noteId) {
  const noteIri = expandIRI(`link:notes/${noteId}`, CONTEXT);
  const noteNode = namedNode(noteIri);

  const hasType = noteQuads.find(q =>
    q.subject.equals(noteNode) && q.predicate.value === RDF_TYPE && q.object.value === PROV_ENTITY
  );
  if (!hasType) return null;

  const valueQuad = noteQuads.find(q => q.subject.equals(noteNode) && q.predicate.value === PROV_VALUE);
  const authorQuad = noteQuads.find(q => q.subject.equals(noteNode) && q.predicate.value === PROV_WAS_GENERATED_BY);
  const timeQuad = noteQuads.find(q => q.subject.equals(noteNode) && q.predicate.value === PROV_GENERATED_AT_TIME);

  return {
    id: noteId,
    iri: noteIri,
    value: valueQuad?.object.value || '',
    authorId: authorQuad?.object.value.split('/').pop(),
    createdAt: timeQuad?.object.value
  };
}

function getAllNotes(noteQuads) {
  const noteIris = new Set();
  noteQuads.forEach(q => {
    if (q.predicate.value === RDF_TYPE && q.object.value === PROV_ENTITY) {
      noteIris.add(q.subject.value);
    }
  });
  return Array.from(noteIris)
    .map(iri => getNote(noteQuads, iri.split('/').pop()))
    .filter(Boolean);
}

function getNotesForComponent(noteQuads, componentDeviceIds) {
  const allNotes = getAllNotes(noteQuads);
  const componentIds = new Set(componentDeviceIds.map(d => d.id));
  return allNotes.filter(note => componentIds.has(note.authorId));
}

function createNote(noteQuads, noteId, value, authorDeviceId) {
  const noteNode = namedNode(expandIRI(`link:notes/${noteId}`, CONTEXT));
  const authorNode = namedNode(expandIRI(`link:device/${authorDeviceId}`, CONTEXT));

  noteQuads.push(
    quad(noteNode, namedNode(RDF_TYPE), namedNode(PROV_ENTITY)),
    quad(noteNode, namedNode(PROV_VALUE), literal(value)),
    quad(noteNode, namedNode(PROV_WAS_GENERATED_BY), authorNode),
    quad(noteNode, namedNode(PROV_GENERATED_AT_TIME), literal(new Date().toISOString()))
  );
}

function updateNote(noteQuads, noteId, newValue) {
  const noteNode = namedNode(expandIRI(`link:notes/${noteId}`, CONTEXT));
  const valuePred = namedNode(PROV_VALUE);

  const filtered = noteQuads.filter(q => !(q.subject.equals(noteNode) && q.predicate.equals(valuePred)));
  filtered.push(quad(noteNode, valuePred, literal(newValue)));
  return filtered;
}

function deleteNote(noteQuads, noteId) {
  const noteNode = namedNode(expandIRI(`link:notes/${noteId}`, CONTEXT));
  return noteQuads.filter(q => !q.subject.equals(noteNode));
}

// ─── Token Logic (Stateless Linking) ───────────────────────────────────────
function signToken(deviceId, exp) {
  return crypto.createHmac('sha256', SECRET).update(`${deviceId}.${exp}`).digest('hex').slice(0, 16);
}
function createToken(deviceId) {
  const exp = Date.now() + 3600000;
  return `${deviceId}.${exp}.${signToken(deviceId, exp)}`;
}
function verifyToken(token) {
  if (!token) return null;
  const [id, exp, sig] = token.split('.');
  if (!id || !exp || !sig) return null;
  if (Date.now() > parseInt(exp)) return null;
  if (signToken(id, exp) !== sig) return null;
  return id;
}

// ─── HTML Rendering ────────────────────────────────────────────────────────
function renderDashboard(deviceId, current, component, notes) {
  const outbound = current.linkedTo.map(id => component.find(d => d.id === id)).filter(Boolean);
  const inbound = component.filter(d => d.linkedTo.includes(current.id));
  const token = createToken(deviceId);

  const labelForm = !current.label || current.label === 'Unnamed' ? `
    <form method="POST" action="./label" style="margin-bottom:2rem;">
      <label style="display:block; margin-bottom:0.5rem; color:#94a3b8;">Name this device:</label>
      <div style="display:flex; gap:0.5rem;">
        <input name="label" required placeholder="e.g. My MacBook" style="flex:1; padding:0.75rem; border-radius:8px; border:1px solid #334155; background:#1e293b; color:#e2e8f0;">
        <button style="padding:0.75rem 1.5rem; background:#16a34a; color:white; border:none; border-radius:8px; cursor:pointer;">Save</button>
      </div>
    </form>
  ` : '';

  const renderDeviceCard = (d, { showUnlink = false, unlinkType = 'outbound' } = {}) => `
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
      <div>
        <div style="font-size:1.1rem; font-weight:600;">${escapeHtml(d.label)}</div>
        <div class="meta">ID: ${d.id}</div>
      </div>
      ${showUnlink ? `<form method="POST" action="./unlink-${unlinkType}" style="margin:0;">
        <input type="hidden" name="target" value="${d.id}">
        <button class="btn" style="background:#7f1d1d;">Unlink</button>
      </form>` : ''}
    </div>
  </div>
`;

  const outboundHtml = outbound.length > 0
    ? outbound.map(d => renderDeviceCard(d, { showUnlink: true })).join('')
    : '<p style="color:#64748b; font-style:italic;">No outbound links. Link to another device below.</p>';

  const renderNoteCard = (note) => {
    const author = component.find(d => d.id === note.authorId);
    const authorLabel = author ? author.label : 'Unknown';
    const isOwner = note.authorId === deviceId;
    return `
      <div class="card note-card">
        <div class="note-header">
          <div class="note-meta">
            <strong>${authorLabel}</strong> · ${new Date(note.createdAt).toLocaleString()}
          </div>
          ${isOwner ? `
            <div class="note-actions">
              <form method="POST" action="./notes/delete" style="display:inline;">
                <input type="hidden" name="id" value="${note.id}">
                <button class="btn btn-small" style="background:#7f1d1d;">Delete</button>
              </form>
            </div>
          ` : ''}
        </div>
        <div class="note-content">${escapeHtml(note.value).replace(/\n/g, '<br>')}</div>
      </div>
    `;
  };

  const notesHtml = notes.length > 0
    ? notes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(renderNoteCard).join('')
    : '<p style="color:#64748b; font-style:italic;">No notes yet. Create one below.</p>';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🌲 Device Dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; max-width: 700px; margin: 0 auto; }
  h1 { color: #4ade80; margin-bottom: 0.5rem; } a { color: #4ade80; text-decoration: none; }
  .meta { color: #64748b; font-family: monospace; font-size: 0.8rem; margin-top: 0.25rem; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 1.25rem; margin-bottom: 0.75rem; }
  .card-title { font-size: 0.8rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
  .token-box { background: #0f172a; padding: 0.75rem; border-radius: 6px; font-family: monospace; font-size: 0.85rem; word-break: break-all; display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .btn { padding: 0.5rem 1rem; background: #334155; color: #e2e8f0; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
  .btn:hover { background: #475569; }
  .btn-small { padding: 0.3rem 0.6rem; font-size: 0.75rem; }
  input, textarea { padding: 0.75rem; border-radius: 8px; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; font-size: 1rem; font-family: inherit; }
  textarea { resize: vertical; min-height: 80px; }
  h2 { color: #e2e8f0; font-size: 1.1rem; margin: 2rem 0 1rem; }
  .info { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; font-size: 0.9rem; color: #94a3b8; }
  .note-card { border-left: 3px solid #4ade80; }
  .note-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .note-meta { font-size: 0.85rem; color: #94a3b8; }
  .note-content { font-size: 0.95rem; line-height: 1.6; color: #cbd5e1; }
  .component-count { display: inline-block; background: #16a34a; color: white; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; margin-left: 0.5rem; }
</style></head><body>
  <h1>🌲 Device Dashboard</h1>

  <div class="info">
    <strong>Connected component:</strong> ${component.length} device(s) share notes. Notes are visible to all devices in your network.
  </div>

  ${labelForm}

  <div class="card" style="border-color:#16a34a;">
    <div class="card-title">This Device</div>
    <div style="font-size:1.2rem; font-weight:600;">${escapeHtml(current.label)}</div>
    <div class="meta">ID: ${deviceId}</div>
  </div>

  <h2>🔗 Linked Devices (${outbound.length})</h2>
  ${outboundHtml}

  <h2>🔗 Links To You (${inbound.length})</h2>
  ${inbound.length > 0
      ? inbound.map(d => renderDeviceCard(d, { showUnlink: true, unlinkType: 'inbound' })).join('')
      : '<p style="color:#64748b; font-style:italic;">No devices have linked to you.</p>'
    }

  <h2>🔑 Your Link Token</h2>
  <p style="color:#94a3b8; font-size:0.9rem; margin-bottom:0.75rem;">Share this token. Another device with a valid session can paste it to create a directed link toward this device. Valid for 1 hour.</p>
  <div class="token-box">
    <span id="token-text">${token}</span>
    <button class="btn" onclick="copyToken()">Copy</button>
  </div>

  <h2>🔗 Add a Link</h2>
  <form method="POST" action="./connect" style="display:flex; gap:0.5rem; margin-bottom:2rem;">
    <input name="token" required placeholder="Paste a token from another device" style="flex:1;">
    <button class="btn" style="background:#16a34a;">Link</button>
  </form>

  <h2>📝 Shared Notes <span class="component-count">${notes.length}</span></h2>
  
  <form method="POST" action="./notes/create" style="margin-bottom:1.5rem;">
    <label style="display:block; margin-bottom:0.5rem; color:#94a3b8;">Create a new note:</label>
    <textarea name="value" required placeholder="Write something..." style="width:100%; margin-bottom:0.5rem;"></textarea>
    <button class="btn" style="background:#16a34a;">Add Note</button>
  </form>

  ${notesHtml}

  <script>
    function copyToken() {
      const text = document.getElementById('token-text').textContent;
      navigator.clipboard.writeText(text).then(() => {
        const btn = event.target;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      });
    }
  </script>
</body></html>`;
}

// ─── HTTP Server ───────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  const deviceId = req.headers['x-forest-device-id'];
  if (!deviceId) {
    res.writeHead(403, { 'Content-Type': 'text/html' });
    return res.end('<h1>403 Forbidden</h1><p>Authentication required. You must access this component through the forest core with a valid session cookie.</p>');
  }

  if (req.method === 'POST' && !checkRateLimit(`post:${deviceId}`, RATE_MAX_POST)) {
    res.writeHead(429, { 'Content-Type': 'text/html' });
    return res.end('<h1>429 Too Many Requests</h1><p>Please slow down.</p><p><a href="./">Back</a></p>');
  }

  try {
    if ((path === '/' || path === '/link' || path === '/link/') && req.method === 'GET') {
      const { quads: deviceQuads, context: deviceContext } = await loadGraph(DEVICES_FILE);
      let current = getDevice(deviceQuads, deviceId);

      if (!current) {
        addDevice(deviceQuads, deviceId, 'Unnamed');
        await saveGraph(DEVICES_FILE, deviceQuads, deviceContext);
        current = getDevice(deviceQuads, deviceId);
      }

      const component = getConnectedComponent(deviceQuads, deviceId);

      const { quads: noteQuads } = await loadGraph(NOTES_FILE);
      const notes = getNotesForComponent(noteQuads, component);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderDashboard(deviceId, current, component, notes));
    }

    if (path === '/label' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const label = (params.get('label')?.trim() || 'Unnamed').slice(0, 100);
        const { quads, context } = await loadGraph(DEVICES_FILE);
        const deviceNode = namedNode(expandIRI(`link:device/${deviceId}`, CONTEXT));
        const labelPred = namedNode(RDFS_LABEL);
        const filtered = quads.filter(q => !(q.subject.equals(deviceNode) && q.predicate.equals(labelPred)));
        filtered.push(quad(deviceNode, labelPred, literal(label)));
        await saveGraph(DEVICES_FILE, filtered, context);
        res.writeHead(303, { 'Location': './' });
        res.end();
      });
      return;
    }

    if (path === '/connect' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const token = params.get('token')?.trim();
        const targetId = verifyToken(token);

        if (!targetId) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          return res.end('<h1>Invalid or expired token.</h1><p><a href="./link/">Back</a></p>');
        }
        if (targetId === deviceId) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          return res.end('<h1>Cannot link a device to itself.</h1><p><a href="./link/">Back</a></p>');
        }

        const { quads, context } = await loadGraph(DEVICES_FILE);
        const updated = linkDevice(quads, deviceId, targetId);
        await saveGraph(DEVICES_FILE, updated, context);

        res.writeHead(303, { 'Location': './' });
        res.end();
      });
      return;
    }

    if (path === '/unlink' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const targetId = params.get('target')?.trim();
        if (!targetId) {
          res.writeHead(303, { 'Location': './' });
          return res.end();
        }
        const { quads, context } = await loadGraph(DEVICES_FILE);
        const updated = unlinkDevice(quads, deviceId, targetId);
        await saveGraph(DEVICES_FILE, updated, context);
        res.writeHead(303, { 'Location': './' });
        res.end();
      });
      return;
    }

    if (path === '/unlink-inbound' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const targetId = params.get('target')?.trim();
        if (!targetId) {
          res.writeHead(303, { 'Location': './' });
          return res.end();
        }
        const { quads, context } = await loadGraph(DEVICES_FILE);
        // Remove the reverse link: target→this (instead of this→target)
        const updated = unlinkDevice(quads, targetId, deviceId);
        await saveGraph(DEVICES_FILE, updated, context);
        res.writeHead(303, { 'Location': './' });
        res.end();
      });
      return;
    }

    if (path === '/notes/create' && req.method === 'POST') {
      let body = '';
      req.on('data', c => {
        body += c;
        if (body.length > 1048576) req.destroy();
      });
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const value = (params.get('value')?.trim() || '').slice(0, 1000);

        if (!value) {
          res.writeHead(303, { 'Location': '../' });
          return res.end();
        }

        const noteId = crypto.randomBytes(8).toString('hex');
        const { quads, context } = await loadGraph(NOTES_FILE);
        createNote(quads, noteId, value, deviceId);
        await saveGraph(NOTES_FILE, quads, context);
        res.writeHead(303, { 'Location': '../' });
        res.end();
      });
      return;
    }

    if (path === '/notes/delete' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const noteId = params.get('id')?.trim();
        if (!noteId) {
          res.writeHead(303, { 'Location': '../' });
          return res.end();
        }

        // Verify ownership
        const { quads: noteQuads } = await loadGraph(NOTES_FILE);
        const note = getNote(noteQuads, noteId);
        if (!note || note.authorId !== deviceId) {
          res.writeHead(403, { 'Content-Type': 'text/html' });
          return res.end('<h1>Forbidden</h1><p>You can only delete your own notes.</p>');
        }

        const { quads, context } = await loadGraph(NOTES_FILE);
        const updated = deleteNote(quads, noteId);
        await saveGraph(NOTES_FILE, updated, context);
        res.writeHead(303, { 'Location': '../' });
        res.end();
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (err) {
    console.error('[link] Error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

// ─── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  await mkdir(COMPONENT_DIR, { recursive: true });
  if (!existsSync(DEVICES_FILE)) {
    const { text } = generate({ quads: [], context: CONTEXT });
    await writeFile(DEVICES_FILE, text);
  }
  if (!existsSync(NOTES_FILE)) {
    const { text } = generate({ quads: [], context: CONTEXT });
    await writeFile(NOTES_FILE, text);
  }
  server.listen(process.env.SOCKET_PATH, () => {
    if (process.send) process.send('ready');
    console.log('[link] 🔗 Ready');
  });
}

boot();