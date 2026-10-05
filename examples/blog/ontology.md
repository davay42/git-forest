# The Git-Forest Ontology: A Complete Guide for Building Sovereign Components

## The Core Metaphor

**Git-forest is not a framework. It is a living ecosystem.**

The computer is the soil. Components are trees. The filesystem is the shared ground where roots intertwine. Git is the memory of growth rings. HTTP is the membrane where the forest meets the outside world.

You are not building software. You are growing a forest.

---

## The Nine Layers of the Forest

### 1. The Membrane (HTTP Routing)
**Biological analog:** The cell membrane—selectively permeable, protecting the interior while allowing controlled exchange with the environment.

**Technical reality:** The kernel strips URL prefixes, injects identity headers, and proxies requests to components via Unix sockets. WebSocket upgrades are handled by intercepting raw TCP streams.

**For agents:** You don't configure routes. You just listen on `process.env.SOCKET_PATH`. The membrane handles the rest.

### 2. The Process Tree (Isolation & Lifecycle)
**Biological analog:** A forest is many trees, each with its own root system, sharing the same soil but maintaining separate identities.

**Technical reality:** Each component is a child process spawned by the kernel. They communicate via IPC (`process.send()`). Crashed components restart automatically. Hot-reload swaps sockets without downtime.

**For agents:** Your component is an autonomous organism. It doesn't know about other components. It just reads and writes files.

### 3. Identity (Device-First Authentication)
**Biological analog:** A plant recognizes its own cells through chemical signatures. A user is recognized through cryptographic proof of device continuity.

**Technical reality:** The kernel issues an HMAC-signed cookie (`forest_session`). On each request, it verifies the signature and injects `x-forest-device-id`. The `/users` component maintains a mycelium map (`deviceId → userId`) and injects `x-forest-user-id` when available.

**For agents:** Read `req.headers['x-forest-user-id']` to know who is acting. No database queries. No session lookups. Just a header.

### 4. State (The Filesystem as Database)
**Biological analog:** The soil contains nutrients, water, and minerals. The filesystem contains data, knowledge, and state.

**Technical reality:** State lives in plain text files (Markdown with MD-LD annotations). `users/alice/index.md` is identity. `payments/alice.md` is transaction history. `catalog/items.md` is domain knowledge.

**For agents:** Read files with `readFile()`. Write files with `appendFile()` or `writeFile()`. No SQL. No ORM. Just text.

### 5. Time (Git as Memory)
**Biological analog:** Tree rings record the history of growth. Git commits record the history of change.

**Technical reality:** The breathing kernel commits filesystem changes every 5 seconds. During sleep, it consolidates. During deep sleep, it optimizes. The `post-receive` hook enables push-to-deploy.

**For agents:** You don't call `git commit`. The kernel breathes your changes into history automatically.

### 6. Coordination (The Mycelium)
**Biological analog:** Fungal networks connect tree roots, allowing them to share nutrients and signals without direct contact.

**Technical reality:** The `/users` component sends `{ type: 'device-map', deviceId, userId }` via IPC. The kernel stores it in a `Map`. On each request, it injects `x-forest-user-id`. Components never call each other over HTTP.

**For agents:** You don't coordinate with other components. You just read the headers the kernel provides.

### 7. Security (The Immune System)
**Biological analog:** Plants have immune responses—chemical defenses, physical barriers, and the ability to isolate infected tissue.

**Technical reality:** The kernel strips untrusted headers from external requests. It uses `timingSafeEqual` for secret comparison. Static file serving validates paths mathematically. The `post-receive` hook requires a `RELOAD_TOKEN`.

**For agents:** Trust the headers the kernel provides. They've been verified.

### 8. Autonomy (The Breathing Kernel)
**Biological analog:** A forest tends itself. Trees grow, shed leaves, and decompose without human intervention.

**Technical reality:** The breathing loop commits changes, sleeps during quiet periods, and introspects during deep sleep (running `git gc`, syncing backups). Components can run autonomously without HTTP endpoints.

**For agents:** Your component can be a daemon that wakes, reads, writes, and sleeps. No cron jobs needed.

### 9. Deployment (Push-to-Grow)
**Biological analog:** Seeds disperse and take root. Changes propagate through the ecosystem.

**Technical reality:** `git push` triggers the `post-receive` hook. The kernel reads the diff and swaps changed components. No build step. No pipeline. No registry.

**For agents:** You write code, push to Git, and the forest grows.

---

## The Component Contract

A component is a folder with an `index.js` file. That's it.

### Minimal Component Template

```javascript
import { createServer } from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const COMPONENT_DIR = process.env.COMPONENT_DIR;
const ROOT = join(COMPONENT_DIR, '..');

const server = createServer(async (req, res) => {
  const userId = req.headers['x-forest-user-id'];
  if (!userId) {
    res.writeHead(401);
    return res.end('Authentication required');
  }

  // Read user state from the soil
  const ledger = await readFile(join(ROOT, 'users', userId, 'payments.md'), 'utf8');
  
  // Write new state to the soil
  await appendFile(join(ROOT, 'users', userId, 'notes.md'), '\nHello, forest.\n');
  
  res.end('Saved.');
});

server.listen(process.env.SOCKET_PATH, () => {
  process.send('ready');
});
```

### The Five Rules

1. **Listen on `process.env.SOCKET_PATH`** — The kernel routes requests here.
2. **Send `'ready'` via IPC** — The kernel knows you're alive.
3. **Read `req.headers['x-forest-user-id']`** — This is who is acting.
4. **Read and write files** — This is your state.
5. **Don't call `git commit`** — The kernel breathes for you.

---

## The Identity Protocol

### The Device-First Model

A user is not an email address. A user is a sovereign entity that owns a constellation of devices.

**The taproot:** `users/{userId}/index.md` contains the user's identity and device mappings.

**The lateral roots:** Each device is a lateral root grafted onto the taproot. Any device can generate recovery links for new devices.

**The mycelium:** The kernel maintains an in-memory map of `deviceId → userId`, fed by the `/users` component via IPC.

### How It Works

1. **First visit:** The kernel issues a `forest_session` cookie containing `deviceId.issuedAt.signature`.
2. **Account creation:** The `/users` component creates `users/{userId}/index.md` and maps the device.
3. **Subsequent visits:** The kernel verifies the cookie, injects `x-forest-device-id`, looks up the user in the mycelium, and injects `x-forest-user-id`.
4. **Recovery:** Any trusted device can generate a recovery link. The new device presents the link, and the `/users` component grafts it onto the taproot.

### For Agents

You don't implement authentication. You just read the header:

```javascript
const userId = req.headers['x-forest-user-id'];
if (!userId) return res.end('Please log in');
```

That's it. The kernel and the `/users` component handle the rest.

---

## The Data Model: MD-LD as Semantic Substrate

### What is MD-LD?

Markdown + Linked Data. It's Markdown with semantic annotations that turn plain text into a knowledge graph.

### Example: A User's Payment Ledger

```markdown
[ex] <tag:example.org,2026:>
[p] <ex:payments/>
[c] <ex:catalog/>

## Payment f70c {=p:payment/f70c .p:Payment label}
[24000] {p:amount}
[usd] {p:currency}
*2026-10-02T06:43:33.605Z* {prov:generatedAtTime ^^xsd:dateTime}
[c-vmt] {+c:item/c-vmt ?p:hasItem}
```

### How to Parse MD-LD

```javascript
import { parse } from '../public/mdld-parse.js';

const text = await readFile('payments/alice.md', 'utf8');
const { quads } = parse({ text });

// Find all payments
const payments = quads.filter(q => q.predicate.value.endsWith('Payment'));

// Find what items a user has access to
const items = quads
  .filter(q => q.predicate.value.endsWith('hasItem'))
  .map(q => q.object.value);
```

### How to Write MD-LD

Just append Markdown with annotations:

```javascript
const block = `
[ex] <tag:example.org,2026:>
[p] <ex:payments/>
[c] <ex:catalog/>
## Payment ${paymentId} {=p:payment/${paymentId} .p:Payment label}
[${amount}] {p:amount}
[${currency}] {p:currency}
*${new Date().toISOString()}* {prov:generatedAtTime ^^xsd:dateTime}
[${itemId}] {+c:item/${itemId} ?p:hasItem}
`;

await appendFile('/payments/alice.md', '\n' + block + '\n');
```

### Testing Without HTTP

You can test MD-LD roundtrips without starting the HTTP server:

```javascript
import { parse, generate } from '../public/mdld-parse.js';

const input = `[test] <tag:example.org,2026:>
## Test {=test:item .test:Item label}
[42] {test:value}
`;

const { quads } = parse({ text: input });
const output = generate({ quads });

console.log(output.text); // Should match input
```

This lets you validate your data model in isolation before wiring it to HTTP endpoints.

---

## The Development Workflow

### 1. Sandbox Development

Create a component folder and write your `index.js`. Test it locally:

```bash
mkdir my-component
cd my-component
node index.js  # Starts listening on SOCKET_PATH
```

### 2. Data Roundtrip Testing

Use MD-LD to test your data model without HTTP:

```javascript
// test.js
import { parse } from '../public/mdld-parse.js';

const testData = await readFile('test-data.md', 'utf8');
const { quads } = parse({ text: testData });

// Test your logic
const result = processData(quads);

// Generate output
const output = generate({ quads: result });
console.log(output.text);
```

### 3. Human-Facing API

Once your logic works, wire it to HTTP:

```javascript
const server = createServer(async (req, res) => {
  const userId = req.headers['x-forest-user-id'];
  const data = await readFile(join(ROOT, 'users', userId, 'data.md'), 'utf8');
  const { quads } = parse({ text: data });
  
  const result = processData(quads);
  res.end(JSON.stringify(result));
});
```

### 4. Human-Facing UI

Generate HTML using the `html` tagged template literal:

```javascript
function html(s, ...v) {
  html.H ??= class extends String { };
  html.E ??= x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return new html.H(s.reduce((o, t, i) => {
    const a = v[i];
    return o + t + (a == null || a === false ? ''
      : a instanceof html.H ? a
        : Array.isArray(a) ? a.flat(Infinity).map(x => x instanceof html.H ? x : html.E(x ?? '')).join('')
          : html.E(a));
  }, ''));
}

function renderPage(data) {
  return String(html`<!DOCTYPE html>
  <html><body>
    <h1>${data.title}</h1>
    <ul>
      ${data.items.map(item => html`<li>${item.name}</li>`)}
    </ul>
  </body></html>`);
}
```

### 5. Deploy

Push to Git. The forest grows.

```bash
git add my-component/
git commit -m "feat: add my-component"
git push
```

The `post-receive` hook triggers a targeted reload. Your component is live in 3 seconds.

---

## Common Patterns for Agents

### Pattern 1: Read-Process-Write

```javascript
async function handleRequest(req, res) {
  const userId = req.headers['x-forest-user-id'];
  
  // Read
  const data = await readFile(join(ROOT, 'users', userId, 'data.md'), 'utf8');
  const { quads } = parse({ text: data });
  
  // Process
  const result = processData(quads);
  
  // Write
  const output = generate({ quads: result });
  await writeFile(join(ROOT, 'users', userId, 'data.md'), output.text);
  
  res.end('Done.');
}
```

### Pattern 2: Access Control

```javascript
async function checkAccess(userId, itemId) {
  const payments = await readFile(join(ROOT, 'users', userId, 'payments.md'), 'utf8');
  const { quads } = parse({ text: payments });
  
  return quads.some(q => 
    q.predicate.value.endsWith('hasItem') && 
    q.object.value.endsWith(itemId)
  );
}
```

### Pattern 3: Aggregation

```javascript
async function aggregateAllUsers() {
  const usersDir = join(ROOT, 'users');
  const userFolders = await readdir(usersDir);
  
  const results = [];
  for (const userId of userFolders) {
    const data = await readFile(join(usersDir, userId, 'data.md'), 'utf8');
    const { quads } = parse({ text: data });
    results.push(processUser(quads));
  }
  
  return results;
}
```

### Pattern 4: Background Daemon

```javascript
// No HTTP server, just a daemon that runs on a schedule
setInterval(async () => {
  const data = await readFile('input.md', 'utf8');
  const result = processData(data);
  await writeFile('output.md', result);
}, 60000); // Every minute

process.send('ready');
```

### Pattern 5: Cross-Component Coordination

You don't coordinate directly. You read files:

```javascript
// In component A
await writeFile(join(ROOT, 'shared', 'data.md'), output);

// In component B
const data = await readFile(join(ROOT, 'shared', 'data.md'), 'utf8');
```

The filesystem is the coordination layer.

---

## The Forest Way

You are not building software. You are growing a forest.

- **Components are trees.** They grow independently, sharing the same soil.
- **The filesystem is the soil.** All state lives in plain text files.
- **Git is the memory.** Every change is recorded in the rings of time.
- **HTTP is the membrane.** It routes requests and injects identity.
- **The kernel is the autonomic nervous system.** It breathes, sleeps, and tends the forest.

The veil is gone. The machine is friendly. The computer is yours.

Plant the seed. Watch the forest grow. 🌲