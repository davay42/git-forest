# git-forest

> A zero-dependency Node.js runtime where the filesystem is the router, directories are isolated components, and Git is the deployment mechanism. 
> *(Note: This is a standalone application server and Micro-PaaS, not a Git CLI plugin).*

## The Philosophy

Modern web development requires a framework, a database, a process manager, and a complex CI/CD pipeline. **git-forest** is a reaction against this bloat. 

It distills application architecture down to its absolute primitives:
- **The Filesystem is the Router:** No configuration files. If a directory exists, it's a route.
- **Directories are Components:** A folder containing an `index.js` is an isolated, self-contained application worker.
- **The `public/` Convention:** A dedicated folder for static assets, strictly separated from infrastructure and code.
- **Git is the Database and Deployment:** State is just files on disk. `git push` deploys code and data simultaneously. The server itself acts as the Git remote.

All of this is achieved in ~250 lines of pure Node.js, using **zero external dependencies** in the core.

---

## Architecture & Mental Model

| Concept | Description |
| :--- | :--- |
| **Core Orchestrator** | The `index.js` file at the root. It watches the filesystem, spawns workers, proxies HTTP requests, manages a centralized Git mutex queue, and serves the Git HTTP backend. |
| **Component** | Any root-level directory containing an `index.js` (e.g., `/poll`, `/mdld`). It represents a distinct feature or microservice. |
| **Worker** | The isolated Node.js process spawned by the core to run a specific component. Workers communicate with the core via Unix domain sockets (`/tmp/forest-<name>.sock`). |
| **Static Assets** | The `public/` directory. The core serves files from here directly. If a user visits `/`, the core automatically serves `public/index.html`. |

### How Routing Works
The core automatically strips the component name from the URL. 
If a user visits `/poll/vote`, the core proxies the request to the `poll` worker with the path `/vote`. **Components are entirely path-agnostic.** You can rename the `poll` directory to `survey`, and the code inside requires zero changes.

---

## Production Bootstrap (Zero-Touch Docker)

To run `git-forest` reliably on the open internet (e.g., via Coolify, Render, or a VPS), you use a self-seeding Docker image. Because the server *is* the Git repository, it requires a persistent volume. 

When the container boots for the first time against an empty volume, an inline `ENTRYPOINT` script automatically initializes the Git repository, installs the deployment hooks, and seeds example components. **You never need to open the remote container terminal.**

### 1. The `post-receive.txt` Hook
Create this file in your repository root. It dictates how the server reacts to `git push`.

```bash
#!/bin/sh
while read oldrev newrev refname; do
    if [ "$oldrev" = "0000000000000000000000000000000000000000" ]; then kill -HUP 1; continue; fi
    if [ "$newrev" = "0000000000000000000000000000000000000000" ]; then continue; fi
    # If the core orchestrator changed, restart the container. Otherwise, hot-reload components.
    if git diff --name-only $oldrev $newrev | grep -q "^index.js$"; then kill -TERM 1; exit 0; else kill -HUP 1; fi
done
```

### 2. The `Dockerfile`
This Dockerfile bakes the seed files into a backup directory and uses an inline shell script to bootstrap the volume on first boot.

```dockerfile
FROM node:22-alpine

# Install git and git-daemon (contains the git-http-backend binary)
RUN apk add --no-cache git git-daemon

# 1. Store seed files and the hook in a backup location inside the image
WORKDIR /opt/git-forest-seed
COPY index.js .
COPY post-receive.txt .
# COPY examples ./examples/ # Optional: seed example components

# 2. Set working directory to /app (where the persistent volume will mount)
WORKDIR /app
EXPOSE 3000

# 3. Inline the entrypoint logic
ENTRYPOINT ["sh", "-c", "\
    if [ ! -f 'index.js' ]; then \
        echo '[init] 🌱 Empty volume detected. Seeding git-forest...'; \
        cp /opt/git-forest-seed/index.js .; \
        if [ -d '/opt/git-forest-seed/examples' ]; then cp -r /opt/git-forest-seed/examples/* . 2>/dev/null || true; fi; \
        git init -b main; \
        git config user.email 'forest@local'; \
        git config user.name 'Forest Server'; \
        git config receive.denyCurrentBranch updateInstead; \
        mkdir -p .git/hooks; \
        cp /opt/git-forest-seed/post-receive.txt .git/hooks/post-receive; \
        chmod +x .git/hooks/post-receive; \
        git add .; \
        git commit -m 'chore: initial seed'; \
        echo '[init] ✅ Seed complete. Ready for git push.'; \
    fi; \
    exec node index.js \
"]
```

### 3. Deployment Configuration
In your deployment platform (e.g., Coolify):
1. Point to your Git repository and select **Dockerfile** as the build pack.
2. Mount a **Persistent Volume** to `/app`.
3. Add Environment Variables: 
   - `PORT=3000`
   - `GIT_SECRET=<generate_a_strong_random_string>`
   - `TRUST_PROXY=1` (If behind Traefik/Caddy/Nginx)

---

## Component Authoring Guide

Components are isolated workers. To integrate seamlessly with the core's zero-downtime swapping and secure Git queue, follow these rules:

### 1. The Zero-Downtime Lifecycle
Components must listen for `SIGTERM` to finish active requests before dying, and send an IPC `'ready'` message when they have bound to their socket. If a component crashes on boot, the core detects this and **keeps the previous version running** to prevent downtime.

```javascript
import { createServer } from 'node:http';
const server = createServer((req, res) => { /* ... */ });

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref(); // Force exit fallback
});

server.listen(process.env.SOCKET_PATH, () => {
  if (process.send) process.send('ready'); // Signal the Core
});
```

### 2. Centralized Git Commits (The Mutex Queue)
Components **never** run `git` commands directly. Instead, they make an internal HTTP POST to the Core's `/_forest/commit` endpoint. The Core handles a strict Promise-based mutex queue to prevent `.git/index.lock` race conditions.

Furthermore, the Core validates a per-component token to ensure a component can **only commit files inside its own directory**.

```javascript
async function commitToForest(files, message) {
  try {
    const res = await fetch(`http://localhost:${process.env.FOREST_CORE_PORT}/_forest/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forest-token': process.env.FOREST_COMPONENT_TOKEN // Injected by Core
      },
      body: JSON.stringify({ files, message })
    });
    return res.json();
  } catch (err) {
    console.error('[component] Failed to request commit:', err);
  }
}

// Usage:
await writeFile('data.json', newData);
await commitToForest([`${process.env.COMPONENT_NAME}/data.json`], 'data: updated state');
```

### 3. The Trailing Slash Rule
The core automatically redirects `/component` to `/component/` to ensure relative URLs in your HTML resolve correctly. Always use relative paths in your HTML (e.g., `<form action="./vote">`).

---

## Advanced Pattern: In-Memory Semantic Graphs

Because `git-forest` treats the filesystem as the database, it is uniquely suited for **MD-LD (Markdown Linked Data)** and semantic knowledge graphs. 

Instead of using SQLite for user state, you can shard state into individual Markdown files (e.g., `state/users/alice.md`). 
1. **Zero Contention:** Concurrent writes to different users hit different files.
2. **In-Memory Caching:** On boot, a component can parse all `.md` files into an in-memory RDF graph using `mdld-parse`. 
3. **Instant Queries:** Analytical queries run against RAM in milliseconds.
4. **AI-Native:** LLM agents can read and write directly to the semantic Markdown files without needing SQL-to-Prompt translation layers.

---

## Security & Edge Cases

The core orchestrator includes several production-hardened security features:

1. **Commit Sandboxing:** Every component is issued a unique, cryptographically secure token on boot. When a component requests a Git commit, the Core verifies that the requested file paths strictly belong to that component's directory. A compromised `poll` component cannot overwrite the `shop` component.
2. **Strict Static Boundary:** The static file server is strictly scoped to the `public/` directory. It is physically impossible to accidentally expose `.env`, `Dockerfile`, or component source code to the web.
3. **Timing-Safe Auth:** The `GIT_SECRET` is validated using `crypto.timingSafeEqual` to prevent side-channel timing attacks.
4. **Rate Limiting:** Failed Git authentication attempts are rate-limited per IP. To prevent IP spoofing bypasses, the `X-Forwarded-For` header is only trusted if `TRUST_PROXY=1` is explicitly set.
5. **Hardened Swaps:** If a pushed component contains a syntax error and crashes instantly, the core catches the early exit, kills the broken process, and leaves the old working version running. 

### The "Developer vs. Data" Collision
Because the server commits data to Git, your local branch may fall behind the remote. 
**The Golden Rule:** Always run `git pull --rebase` locally before pushing new code to ensure you don't overwrite data committed by the live server. For extremely high-churn data (like chat logs or analytics), add the data folder to `.gitignore` and rely purely on the persistent Docker volume.


Here is the distilled `.gitignore` guide block, written to slot directly into the README.

---

## The `.gitignore` Contract: Code, Knowledge, and Soil

Every byte in a git-forest belongs to one of three substances. The `.gitignore` file is the contract that draws the boundary between them.

| Substance | What it is | Persistence | Example |
| :--- | :--- | :--- | :--- |
| **Code** | The context. Logic that transforms inputs into meaning. | Versioned | `index.js`, `public/styles.css` |
| **Knowledge** | Data that has been given context. Semantic, auditable, portable. | Versioned | `votes.md`, `state/users/alice.md` |
| **Soil** | Raw, unprocessed accumulation. The nutrients before photosynthesis. | Ephemeral | `clicks.jsonl`, `sessions/`, `cache/` |

**The core flow of git-forest is photosynthesis:** components absorb raw data from the soil, apply the context of code, and elevate it into knowledge that reaches the light — visible to users, readable by AI agents, and preserved in Git history.

### The Rule

> **Anything not in `.gitignore` is committed. Anything in `.gitignore` is sovereign to this container.**

This is a **whitelist-by-absence** policy. If a component writes a file that isn't declared in its `.gitignore`, that file gets committed and the developer sees it in `git log`. Leaks are visible by default. Silence is not safety — visibility is safety.

### Component-Level Data Contracts

Each component declares its own boundary. Git natively supports hierarchical `.gitignore` files, so every folder is its own policy domain:

```gitignore
# poll/.gitignore
# ─── Soil (ephemeral, sovereign to this container) ───
clicks.jsonl
sessions/
cache/
*.tmp

# Everything not listed above is Knowledge.
# It will be committed, versioned, and backed up automatically.
```

The root `.gitignore` handles global infrastructure:

```gitignore
# .gitignore (root)
node_modules/
.env
.env.*
*.sqlite
*.log
.DS_Store
```

### The Distillation Pattern

Components are responsible for their own photosynthesis — transforming soil into knowledge:

```
clicks.jsonl (soil)  →  aggregate()  →  state/activity.md (knowledge)
  "click at 14:02"       code is the      Alice clicked [47] {+click:alice click:count ^^xsd:integer} times
  "click at 14:05"       context            .prov:Activity
```

1. **Accumulate** raw events in a `.gitignore`d path.
2. **Distill** them into semantic knowledge using code.
3. **Commit** the knowledge via the core's centralized Git queue.
4. **Truncate** the soil when it has been fully consumed.

### What You Get on Restore

When you clone the forest from backup, you receive **all the code and all the knowledge**. You receive **none of the soil**. This is correct. The knowledge is the meaning. The soil was just the fuel. A new instance boots with full understanding of what the system knows, without the noise of how it learned it. 🌲

### Example Pipeline

```
Stripe webhooks ──→ purchases.sqlite ──→ regenerate() ──→ active-students.md
                    (soil: ignored)       (code: context)     (knowledge: committed)
                    
                    10,000 rows           the lens            the projection
                    mutable               deterministic       readable
                    queryable             pure function       diffable
                    regenerable                               versioned
```

### Why Git Makes This Perfect

When you commit `active-students.md`, Git doesn't store the whole file every time. It stores the **delta**. 

After a year of daily regeneration, your Git history contains:

```
a3f2c1d  knowledge: active students  (added: alice@uni.edu)
8b1e4f2  knowledge: active students  (removed: bob@corp.io, added: carol@lab.org)
7d9a0c3  knowledge: active students  (added: dave@school.edu)
```

This is a **compressed, immutable, auditable timeline** of every student activation and deactivation that ever occurred. No database required. No migration scripts. No audit log tables. Just `git log`.

### The Three Guarantees

This pattern gives you three properties that no traditional database provides simultaneously:

**1. The knowledge is always current.**
The committed `active-students.md` is always the latest projection. An LLM agent, a dashboard, or a human can read it at any time without querying a database. It is a *living document*.

**2. The knowledge is always reconstructable.**
If the knowledge file is corrupted or deleted, you regenerate it from the soil. The soil is the source of truth. The knowledge is a cache. But unlike a normal cache, this one has a perfect history.

**3. The knowledge is always time-traversable.**
Want to know who was active on March 15th? `git checkout <march-15-commit> -- active-students.md`. No temporal tables. No `AS OF` clauses. Just Git.

### The Practical Pattern

```javascript
// Inside your component: the regeneration function
async function regenerateKnowledge() {
  // 1. Query the soil (ignored SQLite database)
  const students = await queryPurchasesDb(`
    SELECT email, first_purchase_date 
    FROM purchases 
    WHERE status = 'active' 
    ORDER BY first_purchase_date ASC
  `);

  // 2. Project into knowledge (MD-LD quads)
  let md = '[cs] <tag:cs@local,2026:>\n\n# Active Students\n\n';
  md += `_Last regenerated: ${new Date().toISOString()}_\n\n`;
  
  for (const s of students) {
    md += `- [${s.first_purchase_date}] {+cs:student/${s.email} .cs:ActiveStudent ?cs:firstPurchase}\n`;
  }

  // 3. Write knowledge
  await writeFile('state/active-students.md', md);

  // 4. Commit via centralized queue
  await commitToForest(
    ['state/active-students.md'], 
    `knowledge: active students (${students.length})`
  );
}
```

The soil accumulates continuously. The knowledge regenerates on a schedule (every hour, every webhook, every cron tick). Git stores only the changes. The history is perfect. The current state is always readable. The past is always queryable.


---

## Why Build This?

This pattern is frequently reinvented inside mid-to-large tech companies when platform teams grow tired of Kubernetes and Terraform overhead for internal tools. It is rarely shared because it is considered "boring plumbing."

**git-forest** distills this private pattern into a public, zero-dependency primitive. It is not a framework. It is a new way to structure software where the boundary between code, data, and infrastructure completely dissolves.

**Plant the seed. Watch the forest grow.** 🌲