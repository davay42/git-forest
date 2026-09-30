# git-forest

> A zero-dependency Node.js runtime where the filesystem is the router, directories are isolated components, and Git is the deployment mechanism.

[![NPM](https://img.shields.io/npm/v/@davay/git-forest)](https://www.npmjs.com/package/@davay/git-forest)

## The Epistemological Inversion

Modern software engineering suffers from the "Database Illusion" and "Platform Dependency." We rent infrastructure, configure abstractions, and deploy through pipelines we do not own. 

`git-forest` discards these metaphors. It is not a framework; it is a realignment of computational ontology. It shifts the web from a paradigm of Document Retrieval to a paradigm of **Agentic Computation**.

*   **JavaScript is the Subject (The Will):** The continuous, persistent process holding logic, state transitions, and decision-making capacity.
*   **HTML/CSS is the Phenomenon (The Projection):** The ephemeral, disposable shape the agent takes to communicate with the human visual cortex.
*   **HTTP is the Membrane:** The strict, impermeable boundary of the component’s sovereignty.
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
*   **Component update:** Triggers a zero-downtime hot-swap of the worker process.
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

A component is any root-level directory containing an `index.js`. It is an autonomous agent.

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

### 3. The Teleology (Committing Knowledge)
Components **never** run `git` commands directly. They submit file changes to the Core's mutex queue via an internal HTTP endpoint, authenticated by a per-component token. This prevents `.git/index.lock` race conditions and enforces strict scope boundaries.

```javascript
async function commitKnowledge(files, message) {
  const res = await fetch(`http://localhost:${process.env.FOREST_CORE_PORT}/_forest/commit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forest-token': process.env.FOREST_COMPONENT_TOKEN
    },
    body: JSON.stringify({ files, message })
  });
  return res.json();
}
```

### 4. The Identity (Forest Identity Protocol)
Modern identity is a centralized ledger of PII. `git-forest` treats identity as a **cryptographic proof of device continuity**. The Core issues an `HttpOnly` cookie (`forest_session`) containing a signed `deviceId`. On every request, the Core verifies the HMAC signature and injects the verified ID into the `x-forest-device-id` header before proxying.

*   **Zero Core State:** The Core stores no user tables, no sessions, no databases. Identity is pure math.
*   **Sliding Expiration:** The browser enforces the 90-day hard limit via `Max-Age`. The Core silently renews the signature if the device visits within the 30-day window.
*   **Semantic Edge:** The Core only guarantees the device hasn't been forged. Components read the raw `deviceId` and map it to semantic entities (`Student`, `Customer`) in their own local MD-LD graphs using polarity (`+`/`-`).

```javascript
// Inside a component
const deviceId = req.headers['x-forest-device-id'];
// Map deviceId to a student in shop/students.md
```

### 5. The Gateway (Internal/External Routing)
The Core distinguishes between trusted internal calls and untrusted external traffic using a gateway pattern.

**Internal Calls** (component-to-component):
- Authenticated via `x-forest-token` header (matches `FOREST_COMPONENT_TOKEN`)
- Verified against the Core's `componentTokens` registry
- Bypass identity processing entirely
- Headers pass through unchanged
- Used for component `/commit` API calls and other internal communication

**External Calls** (browser users):
- `x-forest-token` and `x-forest-device-id` headers are stripped (anti-spoofing)
- Identity is resolved from `forest_session` cookie via HMAC-SHA256
- Verified `deviceId` is injected into `x-forest-device-id` header
- Same process for HTTP requests and WebSocket upgrades

```javascript
// Internal call from component to Core
const res = await fetch(`http://localhost:${process.env.FOREST_CORE_PORT}/_forest/commit`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-forest-token': process.env.FOREST_COMPONENT_TOKEN  // Trusted
  },
  body: JSON.stringify({ files, message })
});

// External call from browser (no token needed)
// Core automatically processes identity from cookie
// x-forest-device-id is injected after verification
```

This separation prevents header spoofing attacks and ensures that only registered components can bypass identity checks.

## The Sovereign Ecosystem

Because the entire platform specification fits in roughly 4,000 tokens, modern LLM agents can read this README and one-shot fully functional, 500-line community microservices in seconds. The cost of building highly specific, local software has dropped to zero.

*   **Sovereign Workflows:** Unlimited automation flows, replacing n8n or Make.com.
*   **AI Agent Substrate:** Agents live as components, reading the filesystem, reasoning over semantic data, and committing knowledge to Git.
*   **The Transparent Tunnel:** A 250-LOC WebSocket proxy component that exposes your local forest to the public internet without third-party services like ngrok.
*   **The Personal Cloud:** Polls, journals, webhooks, and cron jobs—each just a folder, versioned in Git, owned entirely by you.

## Security & Edge Cases

1.  **Gateway Routing:** Internal component calls are authenticated via `x-forest-token` and bypass identity processing. External calls strip spoofed headers and require verified identity via HMAC-signed cookies.
2.  **Commit Sandboxing:** Per-component tokens ensure a compromised component cannot overwrite another's files.
3.  **Strict Static Boundary:** The `public/` directory is physically isolated. Path traversal is mathematically blocked.
4.  **Timing-Safe Auth:** `GIT_SECRET` is validated using `crypto.timingSafeEqual`.
5.  **Hardened Swaps:** Syntax errors in pushed code trigger a fallback to the previous working version.
6.  **Self-Healing State:** On boot, the Core auto-commits tracked file modifications to restore push-to-deploy capability, while ignoring untracked Soil to protect Git history.
7.  **Stateless Identity (FIP):** Device identity is verified via HMAC-SHA256 at the edge. No session stores, no JWT bloat, no centralized user databases.

---

*Plant the seed. Watch the forest grow.* 🌲
