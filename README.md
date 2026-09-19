# git-forest

> A zero-dependency Node.js runtime where the filesystem is the router, directories are isolated components, and Git is the deployment mechanism.

## The Rediscovery

We are not inventing a new framework. We are remembering the primitives the creators of the web gave us: HTML, HTTP, the Filesystem, Git, JavaScript, Markdown, and RDF. Modern development buried these under layers of abstraction, build steps, and SaaS subscriptions. `git-forest` strips the soil away to reveal the crystal underneath.

This is not a manifesto; it is a global gift to local communities. A neighborhood association, a school club, a cooperative, or a family can spin up their own sovereign, interactive hub on a $5 VPS, a Raspberry Pi, or a repurposed Android phone sitting in a drawer. 

Furthermore, because the entire platform specification fits in roughly 4,000 tokens, modern LLM agents can read this README and one-shot a fully functional, 600-line community microservice in seconds. The cost of building highly specific, local software has dropped to zero.

---

## The Forest Ontology: Code, Soil, and Knowledge

Every byte in a git-forest belongs to one of three substances. The `.gitignore` file is not a cleanup list; it is a declarative policy schema that defines the boundary between them.

| Substance | What it is | Persistence | Example |
| :--- | :--- | :--- | :--- |
| **Code** | The context. Logic that transforms inputs into meaning. | Versioned | `index.js`, `public/styles.css` |
| **Knowledge** | Data that has been given context. Semantic, auditable, portable. | Versioned | `votes.md`, `state/users/alice.md` |
| **Soil** | Raw, unprocessed accumulation. The nutrients before photosynthesis. | Ephemeral | `clicks.jsonl`, `sessions/`, `cache/` |

**The core flow of git-forest is photosynthesis:** components absorb raw data from the soil, apply the context of code, and elevate it into knowledge that reaches the light—visible to users, readable by AI agents, and preserved in Git history.

> **The Rule:** Anything not in `.gitignore` is committed. Anything in `.gitignore` is sovereign to this container.

This is a **whitelist-by-absence** policy. If a component writes a file that isn't declared, it gets committed and the developer sees it in `git log`. Leaks are visible by default. When you clone a forest from backup, you receive all the code and all the knowledge. You receive none of the soil. The knowledge is the meaning; the soil was just the fuel.

---

## Three Plantable Seeds

To understand the ontology in practice, here are three components ready to be planted in any community forest.

### 1. The Polling Booth (Community Survey)
A tool for local decision-making. Raw votes are kept private and ephemeral; the aggregated consensus is public and permanent.
*   **The Soil (`.gitignore`):** `votes.jsonl` (Raw IP, timestamp, and choice to prevent double-voting).
*   **The Photosynthesis:** On every vote, the component reads the JSONL, recalculates the percentages, and overwrites the results file.
*   **The Knowledge (Committed):** `results.md` (The current public statistics, updated and committed to Git on every single vote).

### 2. The Town Square (Blog & Threads)
A local discussion board. User sessions and unsaved drafts are ephemeral; the conversation itself is the permanent record.
*   **The Soil (`.gitignore`):** `sessions/`, `drafts/` (Ephemeral login tokens, autosaved typing states).
*   **The Photosynthesis:** When a user submits a comment, the component appends it directly to the post's markdown file.
*   **The Knowledge (Committed):** `posts/*.md` (The threads, comments, and likes, stored directly in the post files. `git log` is the moderation history).

### 3. The Seed Library (Resource Sharing)
An educational tool for communities to share physical seeds, tools, or books. Transaction logs are ephemeral; the catalog is the living knowledge.
*   **The Soil (`.gitignore`):** `borrow_logs.jsonl` (Raw checkout/return scans and availability fluctuations).
*   **The Photosynthesis:** A background worker aggregates the logs to determine what is currently on the shelf versus what is checked out.
*   **The Knowledge (Committed):** `catalog/*.md` (The public catalog of seed varieties, planting guides, and current availability status).

---

## Architecture & Mental Model

| Concept | Description |
| :--- | :--- |
| **Core Orchestrator** | The `index.js` file at the root (~250 lines). It watches the filesystem, spawns workers, proxies HTTP requests, manages a centralized Git mutex queue, and serves the Git HTTP backend. |
| **Component** | Any root-level directory containing an `index.js` (e.g., `/poll`). It represents a distinct feature or microservice. |
| **Worker** | The isolated Node.js process spawned by the core. Workers communicate via Unix domain sockets (`/tmp/forest-<name>.sock`). |
| **Static Assets** | The `public/` directory. Strictly separated from code. If a user visits `/`, the core serves `public/index.html`. |

**Routing:** The core automatically strips the component name from the URL. If a user visits `/poll/vote`, the core proxies to the `poll` worker with the path `/vote`. Components are entirely path-agnostic.

---

## Component Authoring Guide

### 1. The Zero-Downtime Lifecycle
Components must listen for `SIGTERM` to finish active requests before dying, and send an IPC `'ready'` message when they have bound to their socket. If a pushed component crashes on boot, the core detects this and **keeps the previous version running** to prevent downtime.

```javascript
import { createServer } from 'node:http';
const server = createServer((req, res) => { /* ... */ });

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

server.listen(process.env.SOCKET_PATH, () => {
  if (process.send) process.send('ready'); // Signal the Core
});
```

### 2. Centralized Git Commits (The Mutex Queue)
Components **never** run `git` commands directly. They make an internal HTTP POST to the Core's `/_forest/commit` endpoint. The Core handles a strict Promise-based mutex queue to prevent `.git/index.lock` race conditions, and validates a per-component token to ensure a component can **only commit files inside its own directory**.

```javascript
async function commitToForest(files, message) {
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

### 3. The Trailing Slash Rule
The core automatically redirects `/component` to `/component/`. Always use relative paths in your HTML (e.g., `<form action="./vote">`).

---

## Production Bootstrap (Zero-Touch Docker)

To run `git-forest` reliably, use a self-seeding Docker image. The server *is* the Git repository, so it requires a persistent volume. When the container boots against an empty volume, it automatically initializes the repo and seeds the hooks.

### The `post-receive.txt` Hook
```bash
#!/bin/sh
while read oldrev newrev refname; do
    if [ "$oldrev" = "0000000000000000000000000000000000000000" ]; then kill -HUP 1; continue; fi
    if [ "$newrev" = "0000000000000000000000000000000000000000" ]; then continue; fi
    if git diff --name-only $oldrev $newrev | grep -q "^index.js$"; then kill -TERM 1; exit 0; else kill -HUP 1; fi
done
```

### The `Dockerfile`
```dockerfile
FROM node:22-alpine
RUN apk add --no-cache git git-daemon

WORKDIR /opt/git-forest-seed
COPY index.js .
COPY post-receive.txt .

WORKDIR /app
EXPOSE 3000

ENTRYPOINT ["sh", "-c", "\
    if [ ! -f 'index.js' ]; then \
        echo '[init] 🌱 Empty volume detected.'; \
        if [ -n \"$GITHUB_BACKUP_URL\" ]; then \
            echo '[init] 🔄 Restoring from GitHub backup...'; \
            git clone \"$GITHUB_BACKUP_URL\" . || { git init -b main; cp /opt/git-forest-seed/index.js .; }; \
        else \
            git init -b main; cp /opt/git-forest-seed/index.js .; \
        fi; \
        git config user.email 'forest@local'; git config user.name 'Forest Server'; \
        git config receive.denyCurrentBranch updateInstead; \
        mkdir -p .git/hooks; cp /opt/git-forest-seed/post-receive.txt .git/hooks/post-receive; \
        chmod +x .git/hooks/post-receive; git add .; \
        git diff --staged --quiet || git commit -m 'chore: initial seed / restore'; \
    fi; exec node index.js"]
```

---

## Security & Edge Cases

1.  **Commit Sandboxing:** Per-component tokens ensure a compromised `poll` component cannot overwrite the `shop` component's files.
2.  **Strict Static Boundary:** The static server is scoped strictly to `public/`. It is physically impossible to expose `.env` or `index.js`.
3.  **Timing-Safe Auth:** `GIT_SECRET` is validated using `crypto.timingSafeEqual`.
4.  **Rate Limiting:** Failed auth attempts are rate-limited per IP. `X-Forwarded-For` is only trusted if `TRUST_PROXY=1` is set.
5.  **Hardened Swaps:** Syntax errors in pushed code trigger a fallback to the previous working version.

---

## Beyond the Core: The Canopy and The Mycelium

### The Canopy: PWAs and Web Push
A git-forest can be installed as a Progressive Web App (PWA) on community members' devices. By using a generic Service Worker, components can send encrypted Web Push notifications. The push service (Google/Apple/Mozilla) acts as a blind, encrypted relay. The content is end-to-end encrypted; the vendor sees nothing, requires no accounts, and cannot block your community. 

### The Mycelium: MD-LD and the `mdld-garden`
While `git-forest` is a pure 0-dep crystal that works perfectly with YAML, JSON, or SQLite, it was designed to be the modular foundation for the **`mdld-garden`**—a greater system built on **MD-LD (Markdown Linked Data)**. 

MD-LD allows components to store state as RDF quads inside Markdown files. This creates a cross-component, Git-versioned, LLM-native semantic knowledge graph. It is highly recommended for complex community hubs, but it remains a choice, not a requirement.

### Hardware Agnosticism
Because the core relies only on TCP, the Filesystem, and Git, network connectivity and access can be delegated to any layer. A git-forest can run on a rooted Android phone via Termux, a Raspberry Pi behind a reverse proxy, or theoretically be ported to an ESP32 compatible hub. 

**Plant the seed. Watch the forest grow.** 🌲