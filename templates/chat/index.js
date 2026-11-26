// chat/index.js — llm-chat as a forest component.
// llm-chat.md is the committed ontology/seed; conversations grow in
// journals/YYYY-MM-DD.md — per-day soil, gitignored, re-parsed per request.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse, evaluate, generate } from '../public/mdld-parse.js';

const COMPONENT_DIR = process.env.COMPONENT_DIR;
const DOC_FILE = join(COMPONENT_DIR, 'llm-chat.md');
const JOURNALS_DIR = join(COMPONENT_DIR, 'journals');
const LLM = 'tag:llm.chat.example,2026:';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const journalPath = d => join(JOURNALS_DIR, `${d}.md`);

async function loadDoc() {
  const { quads, context, statements } = parse({ text: await readFile(DOC_FILE, 'utf8') });
  return { quads, context, statements };
}

// Unfold dormant llm:payload modules inside the seed (steps, day logs, terms)
// the same way llm-chat.mjs does — payload literals re-parse as quads.
function unfold(quads) {
  const all = [...quads];
  for (const q of quads) {
    if (q.predicate.value === LLM + 'payload' && typeof q.object.value === 'string' && q.object.value.includes('{')) {
      try { all.push(...parse({ text: q.object.value }).quads); } catch {}
    }
  }
  return all;
}

async function loadJournals() {
  const files = existsSync(JOURNALS_DIR) ? await readdir(JOURNALS_DIR) : [];
  const quads = [];
  for (const f of files.filter(f => f.endsWith('.md')).sort()) {
    try { quads.push(...parse({ text: await readFile(join(JOURNALS_DIR, f), 'utf8') }).quads); }
    catch (err) { console.error(`[chat] journal ${f}:`, err.message); }
  }
  return quads;
}

async function state() {
  const { quads: docQuads, context } = await loadDoc();
  const journalQuads = await loadJournals();
  const all = unfold([...docQuads, ...journalQuads]);
  return { quads: all, report: evaluate({ quads: all, context }), context };
}

const msgIri = (day, n) => `${LLM}msg-${day}-${String(n).padStart(4, '0')}`;

async function appendExchange(userText, agentText) {
  const day = today();
  const path = journalPath(day);
  const existing = existsSync(path) ? await readFile(path, 'utf8') : `# Day log ${day} {=llm:day-${day} .llm:Conversation label}\n\n`;
  const count = (existing.match(/\{llm:content\}/g) || []).length;
  const now = new Date().toISOString();
  const block = `## ${userText.slice(0, 40)} {=${msgIri(day, count * 2 + 1)} .llm:Message label}
[${now}] {llm:at ^^xsd:dateTime}
[user] {llm:role}
[human] {llm:attributedTo}
[${userText.replace(/\n/g, ' ')}] {llm:content}

## ${agentText.slice(0, 40)} {=${msgIri(day, count * 2 + 2)} .llm:Message label}
[${now}] {llm:at ^^xsd:dateTime}
[agent] {llm:role}
[eval] {llm:attributedTo}
[${agentText.replace(/\n/g, ' ')}] {llm:content}

`;
  await mkdir(JOURNALS_DIR, { recursive: true });
  const tmp = path + '.tmp';
  await writeFile(tmp, existing + block);
  await rename(tmp, path);
}

// Three commands, nothing else:
//   stats            → term/message/record counts
//   what is <term>   → look up a taught term
//   <term> is <def>  → teach a new term (lands in today's journal)
// Anything else gets a contract-status reply.
const termSlug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function findTerm(quads, name) {
  const iri = LLM + 'term-' + termSlug(name);
  const def = quads.find(q => q.subject.value === iri && q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#comment');
  return def ? { iri, def: def.object.value } : null;
}

async function appendTerm(day, name, def) {
  const path = journalPath(day);
  const existing = existsSync(path) ? await readFile(path, 'utf8') : `# Day log ${day} {=llm:day-${day} .llm:Conversation label}\n\n`;
  const key = 'term-' + termSlug(name);
  const block = `## ${name} {=${LLM}${key} .llm:Term label}\n[${def.replace(/\n/g, ' ')}] {rdfs:comment}\n\n`;
  await mkdir(JOURNALS_DIR, { recursive: true });
  const tmp = path + '.tmp';
  await writeFile(tmp, existing + block);
  await rename(tmp, path);
}

async function agentReply(userText, quads, report) {
  const t = userText.trim();

  if (/^(stats|status|how many)/i.test(t)) {
    const terms = new Set(quads.filter(q => q.subject.value.startsWith(LLM + 'term-')).map(q => q.subject.value)).size;
    const messages = new Set(quads.filter(q => q.subject.value.startsWith(LLM + 'msg-')).map(q => q.subject.value)).size;
    return `📊 ${terms} terms · ${messages} messages · ${report.violations.length} violations · ${Object.keys(report.records).length} shapes`;
  }

  const teach = t.match(/^(.+?)\s+(?:is|=|means)\s+(.+)$/i);
  if (teach && !/^(what|how|who|is|are|the|a|an)\b/i.test(teach[1]) && teach[1].length < 60) {
    const [, name, def] = teach;
    if (findTerm(quads, name)) return `"${name}" is already a term — ask "what is ${name}" to look it up.`;
    await appendTerm(today(), name.trim(), def.trim());
    return `taught: **${name.trim()}** → "${def.trim()}" — now a term in ${today()}'s journal`;
  }

  const ask = t.match(/^(?:what is|what's|define|whats|term)\s+(.+?)[?.!]*$/i);
  if (ask) {
    const found = findTerm(quads, ask[1].trim());
    return found ? `**${ask[1].trim()}** — ${found.def}` : `no term "${ask[1].trim()}" yet — teach one: "${ask[1].trim()} is ..."`;
  }

  return `try: "stats" · "what is <term>" · "<term> is <definition>"`;
}

function renderPage(messages, report) {
  const rows = messages.map(m =>
    `<div class="msg ${m.role}"><b>${esc(m.author)}</b> <small>${esc(m.time || '')}</small><p>${esc(m.content)}</p></div>`
  ).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>llm-chat</title>
<link rel="icon" href="data:,"><link rel="stylesheet" href="/styles.css">
<style>
  main { max-width: 720px; }
  .msg { margin: .75rem 0; padding: .75rem 1rem; border-radius: 10px; background: var(--surface); }
  .msg.user { border-left: 3px solid var(--accent); }
  .msg.agent { border-left: 3px solid var(--accent-2); }
  .msg small { color: var(--fg-muted); }
  form { display: flex; gap: .5rem; margin-top: 1.5rem; }
  input { flex: 1; }
  .stats { color: var(--fg-muted); font-size: .85rem; }
</style></head><body class="component-page"><main>
<h1>💬 llm-chat</h1>
<p class="stats">${report.violations.length} violations · ${Object.keys(report.records).length} shapes · journals are per-day soil in <code>journals/</code></p>
<div id="log">${rows || '<p class="empty">No exchanges yet — say something.</p>'}</div>
<form method="POST" action="./chat"><input name="text" placeholder="talk to the document…" autocomplete="off" required><button>Send</button></form>
</main></body></html>`;
}

function collectMessages(quads) {
  const bySubj = new Map();
  for (const q of quads) {
    if (!bySubj.has(q.subject.value)) bySubj.set(q.subject.value, {});
    bySubj.get(q.subject.value)[q.predicate.value] = q.object;
  }
  const out = [];
  for (const [sub, p] of bySubj) {
    if (p[LLM + 'content']?.value && p[LLM + 'attributedTo']?.value) {
      out.push({
        role: p[LLM + 'role']?.value || 'unknown',
        author: p[LLM + 'attributedTo'].value.split(':').pop(),
        content: p[LLM + 'content'].value,
        time: p[LLM + 'at']?.value ? new Date(p[LLM + 'at'].value).toLocaleString() : '',
        iri: sub
      });
    }
  }
  return out.sort((a, b) => (a.iri < b.iri ? -1 : 1));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' && req.method === 'GET') {
      const { quads, report } = await state();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderPage(collectMessages(quads), report));
    }
    if (url.pathname === '/chat' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const text = new URLSearchParams(body).get('text')?.trim();
      if (text) {
        const { quads, report } = await state();
        const reply = await agentReply(text, quads, report);
        await appendExchange(text, reply);
      }
      res.writeHead(303, { Location: './' });
      return res.end();
    }
    if (url.pathname === '/quads.json' && req.method === 'GET') {
      const { quads } = await state();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(quads.map(q => ({ s: q.subject.value, p: q.predicate.value, o: String(q.object.value) }))));
    }
    res.writeHead(404); res.end('Not Found');
  } catch (err) {
    console.error('[chat] error:', err);
    res.writeHead(500); res.end('Internal Server Error');
  }
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });

server.listen(process.env.SOCKET_PATH, () => {
  if (process.send) process.send('ready');
  console.log('[chat] 💬 Ready — llm-chat.md is truth, journals/ is per-day soil');
});
