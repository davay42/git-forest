// eval/index.js — live forest evaluation: the root index.md carries the
// forest contract shapes; every agent doc is gated against them.
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse, evaluate, shortenIRI } from '../public/mdld-parse.js';

const COMPONENT_DIR = process.env.COMPONENT_DIR;
const ROOT = join(COMPONENT_DIR, '..');
const SH = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// recordTable() isn't in the 1.2.6 bundle — minimal semantic-table fallback.
function recordTable(pojo) {
  if (pojo === null || typeof pojo !== 'object') return esc(pojo);
  if (Array.isArray(pojo)) return pojo.length ? `<ul>${pojo.map(v => `<li>${recordTable(v)}</li>`).join('')}</ul>` : '<i>empty</i>';
  const rows = Object.entries(pojo).map(([k, v]) => {
    const cell = v && typeof v === 'object' ? recordTable(v) : esc(v);
    return `<tr><th>${esc(k)}</th><td>${cell}</td></tr>`;
  }).join('');
  return `<table>${rows}</table>`;
}

// A quad belongs to the shape layer when its predicate is an sh: term or its
// subject is typed as a shape — everything else is data awaiting judgment.
function isShapeQuad(q, shapeSubjects) {
  return q.predicate.value.startsWith(SH) || shapeSubjects.has(q.subject.value);
}

async function loadContract() {
  const { quads, context } = parse({ text: await readFile(join(ROOT, 'index.md'), 'utf8') });
  const shapeSubjects = new Set(quads
    .filter(q => q.predicate.value === RDF_TYPE && q.object.value.startsWith(SH))
    .map(q => q.subject.value));
  return { shapeQuads: quads.filter(q => isShapeQuad(q, shapeSubjects)), context };
}

async function discoverDocs() {
  const docs = [{ name: 'kernel', path: join(ROOT, 'index.md') }];
  for (const entry of await readdir(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || ['node_modules', 'public', 'templates'].includes(entry.name)) continue;
    const p = join(ROOT, entry.name, 'index.md');
    if (existsSync(p)) docs.push({ name: entry.name, path: p });
  }
  return docs;
}

async function evaluateDoc(doc, shapeQuads, contractContext) {
  const { quads, context } = parse({ text: await readFile(doc.path, 'utf8') });
  const mergedContext = { ...contractContext, ...context };
  const report = evaluate({ quads, shapes: shapeQuads, context: mergedContext });
  return { doc, quads: quads.length, ...report, context: mergedContext };
}

function renderReport(results) {
  const totalViolations = results.reduce((n, r) => n + r.violations.length, 0);
  const sections = results.map(r => {
    const viol = r.violations.map(v =>
      `<li class="violation">✗ ${esc(v.message || v.component?.value || 'constraint')} — <code>${esc(v.focusNode?.value || '')}</code></li>`
    ).join('');
    const rec = Object.entries(r.records).flatMap(([shape, nodes]) =>
      Object.entries(nodes).map(([node, pojo]) =>
        `<h3>${esc(shortenIRI(shape, r.context))} › ${esc(node)}</h3>${recordTable(pojo)}`)
    ).join('');
    return `<section class="doc">
  <h2>${esc(r.doc.name)} <small>${r.quads} quads · ${r.violations.length} violations</small></h2>
  ${viol ? `<ul class="violations">${viol}</ul>` : '<p class="ok">✓ conforms</p>'}
  <details><summary>records (${Object.keys(r.records).length} shapes)</summary><div class="records">${rec || '<p>none</p>'}</div></details>
</section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>eval — forest evaluation</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/styles.css">
<style>
  .doc { margin: 2rem 0; padding: 1.25rem; background: var(--surface); border-radius: 12px; }
  .doc h2 small { color: var(--fg-muted); font-weight: 400; font-size: 0.8rem; }
  .violations { color: var(--danger); }
  .ok { color: var(--accent); }
  .records table { border-collapse: collapse; margin: .5rem 0 1rem; }
  .records th, .records td { padding: 2px 12px 2px 0; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
  .records th { color: var(--fg-muted); }
  summary { cursor: pointer; color: var(--fg-muted); }
</style></head>
<body class="component-page"><main>
  <h1>🧪 eval — forest evaluation</h1>
  <p class="count">${results.length} documents · ${totalViolations} violations · contract: index.md</p>
  ${sections}
</main></body></html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/' || req.method !== 'GET') {
    res.writeHead(404); return res.end('Not Found');
  }
  try {
    const { shapeQuads, context: contractContext } = await loadContract();
    if (!shapeQuads.length) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('index.md carries no contract shapes');
    }
    const docs = await discoverDocs();
    const results = [];
    for (const doc of docs) {
      try { results.push(await evaluateDoc(doc, shapeQuads, contractContext)); }
      catch (err) { console.error(`[eval] ${doc.name}:`, err.message); }
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderReport(results));
  } catch (err) {
    console.error('[eval] error:', err);
    res.writeHead(500); res.end('Internal Server Error');
  }
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });

server.listen(process.env.SOCKET_PATH, () => {
  if (process.send) process.send('ready');
  console.log('[eval] 🧪 Ready — gating forest MD-LD against the contract in index.md');
});
