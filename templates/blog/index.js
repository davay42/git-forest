// blog/index.js — a generic blog component for git-forest
//
// The component folder IS the blog. Every .md file next to index.js is a post.
//
//   GET /            → chronological index (newest first)
//   GET /{slug}      → post rendered with mdld-parse render()
//   GET /{slug}.md   → the same post, explicit form
//   GET /styles.css  → passthrough of public/styles.css (keeps subdomain routing styled)
//
// Post dates resolve in forest order:
//   1. a semantic date inside the document (literal on *created|date|published|generatedAtTime)
//   2. the git birth ring — first commit that added the file (cached)
//   3. file mtime
//
// Forest contract: listen on SOCKET_PATH, send 'ready', read files, never git commit.

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, basename, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse, render } from '../public/mdld-parse.js';

const COMPONENT_DIR = resolve(process.env.COMPONENT_DIR ?? '.');
const ROOT = join(COMPONENT_DIR, '..');
const BLOG_TITLE = process.env.BLOG_TITLE || process.env.COMPONENT_NAME || basename(COMPONENT_DIR);

const execGit = promisify(execFile);
const birthRings = new Map(); // file → Date of its first commit (git is memory)
const validDate = (d) => (d instanceof Date && !isNaN(+d)) ? d : null;

// ─── HTML (tagged-template escaping, from the forest ontology) ─────────────
function html(s, ...v) {
  return new html.H(s.reduce((o, t, i) => {
    const a = v[i];
    return o + t + (a == null || a === false ? ''
      : a instanceof html.H ? a
        : Array.isArray(a) ? a.flat(Infinity).map(x => x instanceof html.H ? x : html.E(x ?? '')).join('')
          : html.E(a));
  }, ''));
}
html.H = class extends String { };
html.E = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─── soil scanning ─────────────────────────────────────────────────────────
const DATE_PREDICATE = /(created|date|published|generatedAtTime)$/i;

function semanticDate(quads) {
  for (const q of quads) {
    if (q.object.termType !== 'Literal') continue;
    if (!DATE_PREDICATE.test(q.predicate.value.split(/[#/]/).pop())) continue;
    const d = validDate(new Date(q.object.value));
    if (d) return d;
  }
  return null;
}

async function birthRing(relPath) {
  if (birthRings.has(relPath)) return birthRings.get(relPath);
  let born = null;
  try {
    const { stdout } = await execGit('git',
      ['log', '--diff-filter=A', '--follow', '--format=%aI', '--', relPath], { cwd: ROOT });
    const adds = stdout.trim().split('\n').filter(Boolean);
    born = validDate(new Date(adds.at(-1))); // git lists newest first → last line is birth
    if (!born) { // fallback: oldest commit touching the file
      const any = await execGit('git', ['log', '--format=%aI', '--follow', '--', relPath], { cwd: ROOT });
      born = validDate(new Date(any.stdout.trim().split('\n').filter(Boolean).at(-1)));
    }
  } catch { /* not yet committed — mtime will answer */ }
  if (born) birthRings.set(relPath, born);
  return born;
}

function firstHeading(mdText) {
  const clean = mdText.replace(/```[\s\S]*?```/g, ''); // never trust headings inside fences
  const m = clean.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
  if (!m) return null;
  return m[1]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) → text
    .replace(/[*_`~]/g, '')                  // emphasis markers
    .trim() || null;
}

async function collectPosts() {
  const folder = basename(COMPONENT_DIR);
  const posts = [];
  for (const file of await readdir(COMPONENT_DIR)) {
    if (!file.toLowerCase().endsWith('.md') || file.startsWith('.')) continue;
    try {
      const path = join(COMPONENT_DIR, file);
      const { quads, md, primary } = parse({ text: await readFile(path, 'utf8') });
      posts.push({
        slug: file.replace(/\.md$/i, ''),
        title: firstHeading(md) ?? file.replace(/\.md$/i, ''), // md = annotations stripped
        excerpt: primary?.comment ?? '',                       // optional {comment} blockquote
        date: semanticDate(quads) ?? await birthRing(join(folder, file)) ?? (await stat(path)).mtime,
      });
    } catch { /* unreadable file — the forest steps over it */ }
  }
  return posts.sort((a, b) => b.date - a.date); // newest first
}

// ─── routes ────────────────────────────────────────────────────────────────
function resolvePost(slug) {
  let name;
  try { name = decodeURIComponent(slug); } catch { return null; }
  if (!name || name.startsWith('.') || /[/\\\0]/.test(name)) return null;
  if (!name.toLowerCase().endsWith('.md')) name += '.md';
  const path = resolve(COMPONENT_DIR, name);
  return path.startsWith(COMPONENT_DIR + sep) ? { name, path } : null; // mathematically contained
}

function page(title, body) {
  return String(html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="./styles.css">
</head>
<body>
<p><a href="./">← ${BLOG_TITLE}</a></p>
${body}
</body>
</html>`);
}

function postItem(p) {
  return html`
<li>
  <h2><a href="${encodeURIComponent(p.slug)}">${p.title}</a></h2>
  <p><small><time datetime="${p.date.toISOString()}">${p.date.toISOString().slice(0, 10)}</time></small></p>
  ${p.excerpt ? html`<p>${p.excerpt}</p>` : null}
</li>`;
}

function send(res, code, body, type = 'text/html; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

function notFound(res) {
  send(res, 404, page('Not found',
    html`<h1>404</h1><p>This page fell off the branch. <a href="./">Back to the clearing</a>.</p>`));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET' });
      return res.end('A blog only reads.');
    }

    // passthrough so subdomain routing (blog.forest.example) finds styles too
    if (url.pathname === '/styles.css') {
      try { return send(res, 200, await readFile(join(ROOT, 'public', 'styles.css'), 'utf8'), 'text/css; charset=utf-8'); }
      catch { return notFound(res); }
    }

    // index — the kernel already 301'd /blog → /blog/ and stripped the prefix
    if (url.pathname === '/') {
      const posts = await collectPosts();
      const body = html`<h1>🌲 ${BLOG_TITLE}</h1>
${posts.length === 0
          ? html`<p>No posts yet — drop a <code>.md</code> file into this folder and <code>git push</code>.</p>`
          : html`<ul>${posts.map(postItem)}
</ul>`}
<p><small>${posts.length} post(s) · newest first · dated by annotation → git birth ring → mtime</small></p>`;
      return send(res, 200, page(BLOG_TITLE, body));
    }

    // /{filename} or /{filename}.md → mdld-parse render()
    const found = resolvePost(url.pathname.slice(1));
    if (!found) return notFound(res);
    let text;
    try { text = await readFile(found.path, 'utf8'); } catch { return notFound(res); }
    const title = firstHeading(parse({ text }).md) ?? found.name.replace(/\.md$/i, '');
    const body = html`<article>
${new html.H(render(text))}
</article>`; // html.H marks render()'s output as pre-escaped HTML
    return send(res, 200, page(title, body));
  } catch (err) {
    console.error('[blog]', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('The blog hit a snag.');
  }
});

server.listen(process.env.SOCKET_PATH, () => {
  console.log(`[blog] 🌱 "${BLOG_TITLE}" rooted at`, process.env.SOCKET_PATH);
  process.send?.('ready');
});