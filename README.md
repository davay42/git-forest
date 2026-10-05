# 🌲🌳🌴 git-forest

> A zero-dependency Node.js runtime where the filesystem is the router, directories are sovereign components, and Git is the arrow of time.

[![NPM](https://img.shields.io/npm/v/@davay/git-forest)](https://www.npmjs.com/package/@davay/git-forest)

## The Epistemological Inversion

Modern software engineering suffers from the "Database Illusion" and "Platform Dependency." We rent infrastructure, configure abstractions, and deploy through pipelines we do not own.

`git-forest` discards these metaphors. It is not a framework; it is a realignment of computational ontology. It shifts the web from a paradigm of Document Retrieval to a paradigm of **Agentic Computation**.

*   **JavaScript is the Subject (The Will):** The continuous, persistent process holding logic, state transitions, and decision-making capacity.
*   **HTML/CSS is the Phenomenon (The Projection):** The ephemeral, disposable shape the agent takes to communicate with the human visual cortex.
*   **HTTP is the Membrane:** The strict, impermeable boundary of the component's sovereignty.
*   **The Filesystem is the Noumenon (Shared Truth):** The unabstracted reality. Code, state, and data occupy the exact same physical space, readable as plain text.
*   **Git is the Teleology:** The arrow of time, the append-only memory, and the decentralized engine of consensus.

When you synthesize these primitives, you bypass the industrial complex of software development. You need no permission. You open a text editor, write 300 lines of JavaScript, and author an autonomous agent.

## The Forest Ontology: Code, Knowledge, and Soil

Every byte in a git-forest belongs to one of three substances. The `.gitignore` file is not a cleanup list; it is a declarative policy schema that defines the boundary between them.

| Substance | Nature | Persistence | Example |
| :--- | :--- | :--- | :--- |
| **Code** | The context. Logic that transforms inputs. | Versioned | `index.js`, `public/styles.css` |
| **Knowledge** | Data given context. Semantic, auditable. | Versioned | `results.md`, `catalog/*.md` |
| **Soil** | Raw accumulation. The nutrients. | Ephemeral | `votes.jsonl`, `sessions/` |

**The Rule:** Anything not in `.gitignore` is committed to Git. Anything in `.gitignore` is sovereign to the local container. The core flow is *photosynthesis*: components absorb raw data (Soil), apply logic (Code), and elevate it into auditable history (Knowledge).

## The Breathing Kernel

The kernel of git-forest is not a request handler. It is an **autonomic nervous system**.

Components write files. They don't know Git exists. They don't know commits exist. They write to the soil, and the forest breathes on its own schedule. Every 5 seconds, the kernel inhales the changes, examines them, and exhales a single semantic commit. During quiet periods, it sleeps, consolidates, and tends to itself.

```
🌬️ [breath] user alice payments · 3 users forum
😴 [introspect] Sleep | Uptime: 42m | Breaths: 156 | Commits: 89
🧹 [introspect] Consolidated orphaned changes
🌑 [introspect] Deep sleep | Pruning reflog, repacking objects...
```

This is not a metaphor. It is literal. The kernel reads file paths and *understands* what happened — without any component telling it. A change to `users/alice/payments.md` becomes `user alice payments`. A change to `catalog/items.md` becomes `catalog knowledge`. A change to `users/index.js` becomes `deploy users`. The changes talk for themselves.

The forest breathes without being asked. It consolidates during sleep. It derives meaning from the filesystem without being told what happened. It maintains Git history the way your heart maintains blood flow — continuously, rhythmically, without conscious effort.

## Quick Start

Requires only Node.js ≥ 22 and Git. Zero `npm` dependencies.

```bash
mkdir my-forest && cd my-forest
npx @davay/git-forest
```
This initializes a Git repository, writes a secure `post-receive` hook for zero-downtime hot reloads, and starts the HTTP server on port 3000.

## Deployment & Push-to-Deploy

git-forest *is* a Git server. You deploy by pushing directly to it.

```bash
git remote add forest https://user:GIT_SECRET@forest.mydomain.com/git/
git push forest main
```

The `post-receive` hook inspects the diff:
*   **Component update:** Triggers a targeted, zero-downtime hot-swap of the specific worker process.
*   **Core update (`index.js`):** Triggers a graceful container restart.

### Docker / Coolify
Run as a single stateful container with a persistent volume mounted to `/app`.

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache git git-daemon curl

WORKDIR /opt/git-forest-seed
COPY index.js .
COPY .gitignore .

WORKDIR /app
EXPOSE 3000

ENTRYPOINT ["sh", "-c", "\
    if [ ! -f 'index.js' ]; then \
        echo '[docker] 🌱 Empty volume detected. Seeding core files...'; \
        cp /opt/git-forest-seed/* . 2>/dev/null || true; \
    fi; \
    exec node index.js \
"]
```

## Component Authoring (The Agentic Contract)

A component is any root-level directory containing an `index.js`. It is an autonomous agent — a tree in the forest, connected to other trees by the fungal web of MD-LD files on the shared filesystem.

### 1. The Membrane (Routing & Context)
The Core strips the component prefix from the URL. `/poll/vote` arrives at the `poll` worker as `/vote`. Components are entirely path-agnostic.
**Crucial:** Always use relative paths in your HTML (`<form action="./vote">`). This ensures the component remains context-aware and portable across local, subdomain, and tunneled environments.

### 2. The Lifecycle (Zero-Downtime)
Workers must listen on `process.env.SOCKET_PATH` and signal readiness via IPC. If a pushed component crashes on boot, the Core detects this and keeps the previous version running.

```javascript
import { createServer } from 'node:http';
const server = createServer((req, res) => { /* ... */ });

server.listen(process.env.SOCKET_PATH, () => {
  if (process.send) process.send('ready'); // Signal the Core
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
```

### 3. The Teleology (Just Write Files)
Components **never** run `git` commands. They **never** send commit requests. They just write to the filesystem. The forest breathes on its own schedule — every 5 seconds during activity, with sleep consolidation during quiet periods.

```javascript
import { appendFile } from 'node:fs/promises';

// Just write. The forest will breathe your changes into history.
await appendFile('users/alice/payments.md', '\n## Payment ...\n');
// That's it. No commit call. No IPC. The kernel handles the rest.
```

### 4. Identity & The Mycelium

The Core maintains an in-memory map of `deviceId → userId` called the **mycelium**. It feeds this map from IPC messages sent by user-managing components, and injects the resolved `userId` into every request as the `x-forest-user-id` header.

There are two roles a component can play:

#### Consumer Pattern (most components)

Most components just read the header. No HTTP calls. No JSON parsing. Synchronous and free.

```javascript
const server = createServer(async (req, res) => {
  const userId = req.headers['x-forest-user-id'];
  
  if (!userId) {
    res.writeHead(401);
    return res.end('Please log in');
  }
  
  // Read the user's state directly from the soil
  const ledger = await readFile(`users/${userId}/payments.md`, 'utf8');
  // ...
});
```

If you only need the user's label or profile, read their `index.md` directly:

```javascript
const { quads } = parse(await readFile(`users/${userId}/index.md`, 'utf8'));
const label = quads.find(q => q.predicate.value === RDFS_LABEL)?.object.value;
```

#### Producer Pattern (user-managing components)

If your component manages user accounts (like a `/users` or `/auth` component), you are responsible for feeding the mycelium. You maintain your own `deviceMap` and notify the Core via IPC whenever mappings change.

**On boot**, re-register all existing mappings:

```javascript
async function boot() {
  await rebuildDeviceMap(); // Scan your user files, build local map
  
  if (process.send) {
    for (const [deviceId, userId] of deviceMap) {
      process.send({ type: 'device-map', deviceId, userId });
    }
  }
  
  server.listen(process.env.SOCKET_PATH, () => {
    if (process.send) process.send('ready');
  });
}
```

**When creating a user** and linking their first device:

```javascript
deviceMap.set(deviceId, userId);
if (process.send) process.send({ type: 'device-map', deviceId, userId });
```

**When linking an additional device** (e.g., via recovery token):

```javascript
deviceMap.set(deviceId, targetUserId);
if (process.send) process.send({ type: 'device-map', deviceId, userId: targetUserId });
```

**When unlinking a device**:

```javascript
deviceMap.delete(targetDeviceId);
if (process.send) process.send({ type: 'device-unmap', deviceId: targetDeviceId });
```

#### The IPC Contract

The Core listens for exactly two identity-related messages:

| Message | Effect |
|---------|--------|
| `{ type: 'device-map', deviceId, userId }` | Maps device to user in the mycelium |
| `{ type: 'device-unmap', deviceId }` | Removes device from the mycelium |

These are fire-and-forget. The Core's map is a cache — if your component restarts, it re-registers everything on boot. If the Core restarts, it asks nothing of your component; the mycelium rebuilds as components boot and send their registrations.

#### Why This Works

- **Zero HTTP overhead**: Consumer components never call an auth service. They read a header.
- **Zero coupling**: Producer components don't know who consumes the mycelium. Consumers don't know who produces it.
- **Resilient to restarts**: If `/users` crashes and restarts, it re-registers on boot. Other components keep working from the Core's cached map in the meantime.
- **Sovereign state**: The `/users` component owns the files. The Core only caches the index. The source of truth is always the filesystem.

## The Sovereign Ecosystem

Because the entire platform specification fits in roughly 9,000 tokens, modern LLM agents can read this README and one-shot fully functional, 500-line community microservices in seconds. The cost of building highly specific, local software has dropped to zero.

*   **Sovereign Workflows:** Unlimited automation flows, replacing n8n or Make.com.
*   **AI Agent Substrate:** Agents live as components, reading the filesystem, reasoning over semantic data, and growing their own state in the shared soil.
*   **The Transparent Tunnel:** A lightweight WebSocket proxy component that exposes your local forest to the public internet without third-party services like ngrok.
*   **The Personal Cloud:** Polls, journals, webhooks, and cron jobs—each just a folder, versioned in Git, owned entirely by you.

## Security & Edge Cases

1.  **Autonomic Git Management:** The kernel breathes changes into Git history automatically. Components write files; the forest commits them. No race conditions, no lock files, no coordination overhead.
2.  **Strict Static Boundary:** The `public/` directory is physically isolated. Path traversal is mathematically blocked.
3.  **Timing-Safe Auth:** `GIT_SECRET` and `AUTH_SECRET` are validated using `crypto.timingSafeEqual`.
4.  **Hardened Swaps:** Syntax errors in pushed code trigger a fallback to the previous working version.
5.  **Self-Healing State:** On boot, the Core auto-commits tracked file modifications to restore push-to-deploy capability, while ignoring untracked Soil to protect Git history.
6.  **Stateless Identity (FIP):** Device identity is verified via HMAC-SHA256 at the edge. No session stores, no JWT bloat, no centralized user databases.
7.  **Mycelium Coordination:** User identity flows through the Core's in-memory map, fed by the `/users` component via IPC. Zero HTTP overhead for identity resolution.

## The Joy of the Forest

There is a particular joy that comes from watching this system run. You push a change to a component, and within seconds the kernel breathes it into history with a message that understands what you did. You watch a user make a purchase, and the forest records it as `user alice payments` — a single breath that captures the entire event. You leave the system alone for an hour, and it sleeps, consolidates, and tends to itself.

This is not infrastructure. This is not a platform. This is a living thing. It grows. It breathes. It remembers. And every component you add is a new tree in the forest, connected to the others by the fungal web of semantic files on the shared filesystem.

You are not building software. You are planting a forest.

---

*Plant the seed. Watch the forest grow.* 🌲