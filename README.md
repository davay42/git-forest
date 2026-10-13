# 🌲 git-forest

> A sovereign runtime where the filesystem is the database, directories are autonomous agents, and Git is the arrow of time.

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 8: Identification (userId ↔ deviceId mapping)        │
├─────────────────────────────────────────────────────────────┤
│  Layer 7: Authentication (deviceID as httpOnly cookie)      │
├─────────────────────────────────────────────────────────────┤
│  Layer 6: Seeds (MD-LD portable specifications)             │
├─────────────────────────────────────────────────────────────┤
│  Layer 5: Memory (Git — autonomic, append-only history)     │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Truth (Filesystem — shared, plain text reality)   │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Membrane (Unix Domain Sockets — isolation)        │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Projection (HTML/CSS — ephemeral UI)              │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Will (JavaScript — persistent logic & state)      │
└─────────────────────────────────────────────────────────────┘
```

This is not a framework. It is a realignment of computational ontology — a declaration that software can be **owned, understood, and evolved** by a single person with a text editor.

---

## I. The Eight Layers of Sovereignty

Modern software engineering suffers from the **Database Illusion** and **Platform Dependency**. We rent infrastructure, configure abstractions we do not control, and deploy through pipelines owned by corporations whose interests diverge from our own.

`git-forest` returns to first principles. Every byte of the system can be understood through eight layers:

| Layer | Metaphor | Abstraction | Technology |
|-------|----------|-------------|------------|
| **1. The Will** | The living process | Business logic, state transitions | Node.js (zero dependencies) |
| **2. The Projection** | The visible form | HTTP responses, user interfaces | HTML + CSS + vanilla JS |
| **3. The Membrane** | The sovereign boundary | Request routing, isolation | Unix Domain Sockets |
| **4. The Truth** | The shared reality | Code + Knowledge + Soil | Filesystem (plain text) |
| **5. The Memory** | The arrow of time | Append-only history, consensus | Git (autonomic commits) |
| **6. The Seeds** | The reproductive unit | Portable specifications | MD-LD (Markdown-Linked Data) |
| **7. Authentication** | The device's claim | "I am this browser" | HMAC-signed httpOnly cookie |
| **8. Identification** | The person's link | "This device belongs to Alice" | Device-to-user mapping |

When you synthesize these primitives, you bypass the industrial complex of software development. You need no permission. You open a text editor, write 300 lines of JavaScript, and author an autonomous agent that lives, breathes, and remembers.

---

## II. The Forest Ontology: Code, Knowledge, and Soil

Every byte in a git-forest belongs to one of three substances. The `.gitignore` file is not a cleanup list — it is a **declarative policy schema** that defines the boundary between them.

### The Three Substances

| Substance | Metaphor | Persistence | Examples |
|-----------|----------|-------------|----------|
| **Code** | The tree's DNA | Versioned in Git | `index.js`, `public/styles.css` |
| **Knowledge** | The tree's rings | Versioned in Git | `catalog/offers.md`, `content/**/*.md` |
| **Soil** | The nutrients | Ephemeral, ignored | `users.json`, `sessions/`, `votes.jsonl` |

**The Rule:** Anything not in `.gitignore` is committed to Git. Anything in `.gitignore` is sovereign to the local container. The core flow is *photosynthesis*: components absorb raw data (Soil), apply logic (Code), and elevate it into auditable history (Knowledge).

### The Exemplar: `users.json`

The `users.json` file at the forest root is the primary example of Soil. It is a volatile cache — a temporary shared state file that enables efficient coordination between the kernel and user-managing components.

**Why it exists:** The kernel needs to know which device belongs to which user in order to inject `x-forest-user-id` headers. Scanning MD-LD profile files on every request would be wasteful. A flat JSON file, watched by the kernel via `fs.watch`, provides O(1) lookups with zero parsing overhead.

**Why it is ignored:** `users.json` is derivable. On boot, any user-managing component can scan its semantic profile files and reconstruct the mapping. If the file is lost, it is rebuilt. If it is edited manually, it is respected. It is soil — the fertile medium in which identity coordination happens, not the knowledge itself.

This is why most forest `.gitignore` files include a broad `*.json` pattern. JSON happens to be the most efficient format for temporary shared state — not because we encourage it, but because we acknowledge its inevitable presence as part of a living ecosystem. When components need to coordinate quickly, they reach for the soil. When they need to remember, they reach for MD-LD.

### The Ground Cover: `public/`

The `public/` directory is the **grass cover** — the first safe boundary between the forest and the external world.

1. **Safe for Crawlers**: Bots and search engines can safely crawl `public/` without triggering component logic.
2. **Static Sovereignty**: HTML, CSS, and client-side JavaScript live here, served directly by the kernel with zero component overhead.
3. **The Emergence Point**: Components grow *through* this layer. When a request arrives for `/user/profile`, the kernel checks if `user/` exists as a component. If yes, it proxies the request. If no, it serves `public/user/profile.html` (if it exists).
4. **The Seed Bank**: MD-LD documents in `public/` (like `public/ontology.md`) serve as seeds — portable specifications that can reproduce entire components in any environment.

---

## III. The Identity Protocol (Layers 7 & 8)

Identity in git-forest is split into two distinct but related concerns: **Authentication** (proving the device is itself) and **Identification** (linking the device to a person).

### Layer 7: Authentication

Every browser that visits the forest receives a signed cookie containing a `deviceId`:

```
forest_session = {deviceId}.{issuedAt}.{signature}
```

The signature is HMAC-SHA256 over `{deviceId}.{issuedAt}` using a secret known only to the kernel. The cookie is `HttpOnly`, `SameSite=Lax`, and conditionally `Secure`. It lives for 90 days and is automatically renewed 30 days before expiry.

When the browser returns, the kernel verifies the signature with `crypto.timingSafeEqual` and extracts the `deviceId`. If verification fails, a new device is issued. This proves the device is itself — but says nothing about who owns it.

### Layer 8: Identification

Identification is the moment a device is linked to a person. A user arrives, types a nickname, and the user component writes:

```json
// /users.json
{
  "8ec1fe132416fbb2": "alice"
}
```

Now the kernel knows: when device `8ec1fe...` makes a request, inject `x-forest-user-id: alice`.

**The user's responsibility space:**
- Setting a nickname (the minimum identification)
- Issuing time-limited recovery links to claim additional devices
- Optionally adding TOTP, passkeys, or other factors
- Unlinking devices when they are lost or compromised

The kernel doesn't care how identification happens. It only reads `users.json` and trusts the mapping. This is sovereignty in action — the identity protocol is owned by the forest operator, not the platform.

---

## IV. The Breathing Kernel

The kernel of git-forest is not a request handler. It is an **autonomic nervous system**.

### How Breathing Works

Components write files. They don't know Git exists. They don't know commits exist. They write to the soil, and the forest breathes on its own schedule:

```
🌬️ [breath] user alice payments · 3 users forum
😴 [introspect] Sleep | Uptime: 42m | Breaths: 156 | Commits: 89
🧹 [introspect] Consolidated orphaned changes
🌑 [introspect] Deep sleep | Pruning reflog, repacking objects...
```

**The breath cycle:**
- Every **5 seconds** during activity: check for changes, stage them, commit with a semantic message
- After **5 minutes** of quiet: enter sleep mode, consolidate orphaned changes
- After **1 hour** of deep quiet: enter deep sleep, prune reflog, repack Git objects

This is not a metaphor. It is literal. The kernel reads file paths and *understands* what happened:
- `users/alice/payments.md` → `user alice payments`
- `catalog/items.md` → `catalog knowledge`
- `users/index.js` → `deploy users`

The forest breathes without being asked. It consolidates during sleep. It derives meaning from the filesystem without being told what happened. It maintains Git history the way your heart maintains blood flow — continuously, rhythmically, without conscious effort.

### The Mycelium Network

The kernel watches `/users.json` at the forest root. When the file changes, it reloads the device-to-user mapping into memory. Every request is then enriched with:

- `x-forest-device-id`: the authenticated device (always present)
- `x-forest-user-id`: the identified user (if the device is linked)

Components read these headers directly. No HTTP calls. No JSON parsing. No latency. This is the mycelium — the fungal web connecting all trees through the shared soil.

---

## V. Component Architecture

A component is any root-level directory containing an `index.js`. It is an autonomous agent — a tree in the forest, connected to other trees by the mycelium of shared files.

### The Agentic Contract

Every component must fulfill three obligations:

#### 1. The Membrane (Routing & Context)

The kernel strips the component prefix from the URL. `/catalog/checkout` arrives at the `catalog` worker as `/checkout`. Components are entirely path-agnostic.

**Crucial:** Always use relative paths in your HTML (`<form action="./checkout">`). This ensures the component remains context-aware and portable across local, subdomain, and tunneled environments.

#### 2. The Lifecycle (Zero-Downtime)

Workers listen on `process.env.SOCKET_PATH`. Readiness is signaled by the socket file existing and accepting connections. The kernel polls with exponential backoff (up to 15 seconds). No IPC is required.

```javascript
import { createServer } from 'node:http';

const server = createServer((req, res) => { /* ... */ });

server.listen(process.env.SOCKET_PATH, () => {
  console.log('Component ready');
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
```

#### 3. The Teleology (Just Write Files)

Components **never** run `git` commands. They **never** send commit requests. They just write to the filesystem. The forest breathes on its own schedule.

```javascript
import { appendFile } from 'node:fs/promises';

await appendFile('users/alice/payments.md', '\n## Payment ...\n');
// That's it. No commit call. No IPC. The kernel handles the rest.
```

### A Runnable User Component

The following is a complete, self-contained user component that demonstrates the full lifecycle: scanning MD-LD profiles, parsing them, building device-to-user mappings, and writing the shared state file.

```javascript
// user/index.js — Minimal sovereign user management
import { createServer } from 'node:http';
import { readFile, writeFile, appendFile, rename, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { parse } from '../public/mdld-parse.js';

const COMPONENT_DIR = process.env.COMPONENT_DIR;
const ROOT = join(COMPONENT_DIR, '..');
const PROFILES_DIR = join(COMPONENT_DIR, 'profiles');
const STATE_FILE = join(ROOT, 'users.json');
const PREFIX = 'https://example.com/user/';

const deviceMap = new Map();

// Rebuild the device map from semantic profile files
async function rebuildDeviceMap() {
  deviceMap.clear();
  if (!existsSync(PROFILES_DIR)) return;

  for (const entry of await readdir(PROFILES_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const userId = entry.name.replace('.md', '');
    try {
      const { quads } = parse({ text: await readFile(join(PROFILES_DIR, entry.name), 'utf8') });
      for (const q of quads) {
        if (q.predicate.value.endsWith('hasDevice')) {
          const deviceId = q.object.value.split('/').pop();
          deviceMap.set(deviceId, userId);
        }
      }
    } catch (err) {
      console.error(`[user] Failed to parse ${entry.name}:`, err.message);
    }
  }
  console.log(`[user] 🗺️ Rebuilt device map: ${deviceMap.size} devices`);
}

// Atomically write the shared state file
async function syncStateFile() {
  const content = JSON.stringify(Object.fromEntries(deviceMap), null, 2);
  const tmpPath = STATE_FILE + '.tmp';
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, STATE_FILE);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const deviceId = req.headers['x-forest-device-id'];

  if (!deviceId) {
    res.writeHead(403);
    return res.end('No device identity');
  }

  // Claim a new user account for this device
  if (path === '/claim' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const label = new URLSearchParams(body).get('label')?.trim() || 'Anonymous';
      const userId = crypto.randomBytes(4).toString('hex');

      const profile = `[user] <${PREFIX}>

# ${label} {=user:account/${userId} .user:User label}
[Device ${deviceId.slice(0, 8)}] {=user:device/${deviceId} ?user:hasDevice}
`;
      await mkdir(PROFILES_DIR, { recursive: true });
      await writeFile(join(PROFILES_DIR, `${userId}.md`), profile);
      deviceMap.set(deviceId, userId);
      await syncStateFile();

      res.writeHead(303, { 'Location': './' });
      res.end();
    });
    return;
  }

  // Dashboard
  const userId = deviceMap.get(deviceId);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(userId
    ? `<h1>Welcome</h1><p>User: ${userId}</p><p>Device: ${deviceId.slice(0, 8)}...</p>`
    : `<h1>Claim Account</h1>
       <form method="POST" action="./claim">
         <input name="label" placeholder="Your name" required>
         <button>Claim</button>
       </form>`
  );
});

async function boot() {
  await rebuildDeviceMap();
  await syncStateFile();
  server.listen(process.env.SOCKET_PATH, () => {
    console.log(`[user] 🌲 Ready (${deviceMap.size} devices mapped)`);
  });
}

boot();
```

This is the entire user component — under 100 lines of logic. It scans MD-LD profile files on boot, rebuilds the device map, writes the shared state file, and serves a minimal dashboard. The kernel watches the state file and enriches every request across the forest.

### The Two Patterns

**Consumer Pattern (most components):** Just read `x-forest-user-id` from the headers. No HTTP calls, no JSON parsing, no overhead.

```javascript
const userId = req.headers['x-forest-user-id'];
if (!userId) return res.writeHead(401).end('Please log in');
const ledger = await readFile(`users/${userId}/payments.md`, 'utf8');
```

**Producer Pattern (user-managing components):** Rebuild from semantic files on boot, sync the state file on every mutation. The component owns the knowledge; `users.json` is the volatile cache.

---

## VI. The DNA Double Helix: JS + MD-LD

A forest component has two strands, expressed in two distinct but coupled domains:

- **JavaScript** is the **behavioral strand** — what happens when requests arrive, how state transitions, where logic branches.
- **MD-LD** is the **declarative strand** — what entities exist, what relationships hold, what the domain means.

Each strand is derivable from the other. Given a complete MD-LD ontology, a capable agent can generate conforming JavaScript. Given a complete JavaScript implementation, a capable agent can extract the MD-LD ontology it implicitly enforces. Together, they form a **self-correcting interactive knowledge substrate** — when one strand drifts, the other reveals the divergence.

### Choosing Between the Strands

If you had to choose one without access to a trusted LLM and the capacity to test the resulting output properly, **choose JavaScript**. Code is the behavioral truth. It runs. It fails. It reveals its errors. MD-LD without verification is aspirational; JavaScript without documentation is still functional.

But when you have an LLM available, MD-LD becomes a 10x accelerator. You write the ontology once — the entities, the activities, the relationships — and the agent generates conforming code in seconds. The ontology becomes the specification, the test suite, and the documentation, all in one file.

The two strands are not in competition. They are **complementary expressions of the same truth**. The code enacts the ontology. The ontology describes the code. Either can be regenerated from the other. This is the DNA of a forest component — the double helix that makes it alive, self-correcting, and reproducible.

```
         ┌──────────────────┐
         │  Component DNA   │
         ├──────────────────┤
   ┌─────┤ index.js (Will)  │◄──── behavioral strand
   │     ├──────────────────┤
   │     │ index.md (Seed)  │◄──── declarative strand
   │     └──────────────────┘
   │              ▲
   │              │ derivable from each other
   │              ▼
   │     ┌──────────────────┐
   └────►│ instances/*.md   │◄──── Knowledge (versioned)
         ├──────────────────┤
         │ state/*.json     │◄──── Soil (ephemeral)
         └──────────────────┘
```

---

## VII. The Seed Protocol: MD-LD as Reproductive Unit

**MD-LD (Markdown-Linked Data)** is the seed — a portable specification that can reproduce entire components in any environment.

### How Seeds Work

An `index.md` MD-LD document in `<component>/` directory (like `poll/index.md`) contains:
- **Entity definitions**: What exists (classes, properties, relationships)
- **Activity definitions**: What happens (processes, inputs, outputs)
- **Semantic examples**: Real instances that validate the schema

When an LLM agent reads this seed, it can:
1. Generate the component's `index.js` (the behavioral strand)
2. Create the filesystem structure (the root system)
3. Populate initial state (the first leaves)
4. Deploy and run (the tree comes alive)

### Example: A Polling Component Seed

```markdown
[poll] <tag:example.org,2026:poll/>
[user] <tag:example.org,2026:user/>

# Poll Component Ontology

## Entities
### Poll {=poll:Poll .Class label}
> A question with multiple choices.{comment}
Presents *choices* {+poll:choice ?prov:value} with optional custom text variant.

### Vote {=poll:Vote .Class label}
*Activity* {+prov:Entity ?subClassOf}
> A user's selection, linked to their account. {comment}
Records *user account* {+user:Account ?prov:wasAttributedTo}, the *poll* {+poll:Poll ?prov:wasDerivedFrom} and the chosen *value* {+rdf:Literal ?prov:value} and the *time* {+xsd:dateTime ?prov:generatedAtTime}.

## Activities 
### Cast Vote {=poll:CastVote .Class label}
*Activity* {+prov:Activity ?subClassOf}
*Uses* [Poll] {+poll:Poll ?prov:used}
*Associates with* [User Account] {+user:Account ?prov:wasAssociatedWith}
*Generates* [Vote] {+poll:Vote ?prov:generated}

# Example Poll

## Favorite Color? {=poll:favorite-color .poll:Poll label}
> Choose one of presented choices or type your own variant {comment}
Choices: [Red] {poll:choice}, [Blue] {poll:choice}, [Green] {poll:choice}
### Votes
*Vote 1* {=poll:votes/1 .poll:Vote label}: *Alice* {+user:account/234eed1139 ?prov:wasAttributedTo} answered to [Favorite Color?] {+poll:favorite-color ?prov:wasDerivedFrom} at [2026-10-13T08:43:33.757Z] {prov:generatedAtTime ^^xsd:dateTime}: **Red** {prov:value}.

```

An agent reads this seed and generates a complete, working polling component in seconds. The seed contains everything needed: the data model, the behavior, and a validation example.

### Why Seeds Matter

- **Portability**: A seed can be planted in any git-forest instance
- **Reproducibility**: The same seed produces the same component everywhere
- **Evolution**: Seeds can be forked, modified, and shared like Git repositories
- **AI-Native**: LLMs can read seeds and generate code that conforms to the specification

The seed is the **reproductive unit** of the forest — the means by which components propagate across environments.

---

## VIII. Real-World Ecosystems

Because the entire platform specification fits in roughly 10,000 tokens, and because each component is a few hundred lines of JavaScript plus an MD-LD ontology, the cost of building highly specific, local software has dropped to near zero. This makes it practical to build forests for communities and businesses that would never justify a "real" software project.

### The Family Forest

A family of four runs a forest on a $5 VPS (or a Raspberry Pi in the closet):

- **`notes/`** — shared family notes, grocery lists, travel plans
- **`recipes/`** — the family cookbook with photos and ingredient lists
- **`things/`** — a catalog of owned items with serial numbers and manuals
- **`gallery/`** — a private photo gallery with albums and tags
- **`calendar/`** — shared events, appointments, reminders

Each is a component. Each is owned by the family. Each is versioned in Git. When the kids grow up and move out, they fork the forest and take their portion with them. No data migration. No export scripts. Just `git clone`.

### The Coffee Shop Forest

A small coffee shop runs a forest on a laptop behind the counter:

- **`inventory/`** — bean stock, milk levels, cup counts
- **`suppliers/`** — contact info, order history, payment terms
- **`shifts/`** — staff scheduling with shift swaps
- **`recipes/`** — drink formulas with cost calculations
- **`customers/`** — loyalty program with purchase history

The owner edits `suppliers/index.md` in a text editor when a new vendor is added. The barista checks `inventory/` on their phone before ordering. The accountant reads the Git log to reconstruct the quarter. No SaaS subscription. No cloud dependency. No vendor lock-in.

### The School Forest

A small music school runs a forest on a VPS:

- **`content/`** — courses, modules, units, lesson plans
- **`catalog/`** — offers, pricing, Stripe integration
- **`video/`** — lesson videos with signed streaming URLs
- **`user/`** — student accounts with device linking
- **`waitlist/`** — prospective student signups

When a student purchases a course, the `catalog` component writes a receipt, and the `content` component serves the lessons. When the school adds a new course, the owner writes the curriculum in MD-LD and the platform renders it automatically.

### The Pattern

These examples seem "too simple" — and they are. That is the point. **Simple is good enough in 95% of cases.** The other 5% need Kubernetes; the 95% need a text editor, Git, and Node.js. Forest is for the 95%.

---

## IX. Deployment & Operations

### Quick Start

Requires only Node.js ≥ 22 and Git. Zero `npm` dependencies.

```bash
mkdir my-forest && cd my-forest
npx @davay/git-forest
```

This initializes a Git repository, writes a secure `post-receive` hook for zero-downtime hot reloads, and starts the HTTP server on port 3000.

### Push-to-Deploy

git-forest *is* a Git server. You deploy by pushing directly to it:

```bash
git remote add forest https://user:GIT_SECRET@forest.mydomain.com/git/
git push forest main
```

The `post-receive` hook inspects the diff:
- **Component update**: Triggers a targeted, zero-downtime hot-swap of the specific worker process
- **Core update (`index.js`)**: Triggers a graceful container restart

### Docker / Coolify

Run as a single stateful container with a persistent volume mounted to `/app`:

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

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP server port |
| `GIT_SECRET` | (none) | Password for Git push-to-deploy |
| `AUTH_SECRET` | (random) | HMAC key for device identity signing |
| `GIT_BACKUP_URL` | (none) | Remote Git URL for backup pushes |
| `FOREST_BREATH_MS` | `5000` | Breathing interval (milliseconds) |
| `FOREST_SLEEP_AFTER_MS` | `300000` | Enter sleep after this quiet period |
| `FOREST_DEEP_SLEEP_AFTER_MS` | `3600000` | Enter deep sleep after this quiet period |

---

## X. Security & Resilience

### The Seven Shields

1. **Autonomic Git Management**: The kernel breathes changes into Git history automatically. Components write files; the forest commits them. No race conditions, no lock files, no coordination overhead.

2. **Strict Static Boundary**: The `public/` directory is physically isolated. Path traversal is mathematically blocked by the kernel's file serving logic.

3. **Timing-Safe Auth**: `GIT_SECRET` and `AUTH_SECRET` are validated using `crypto.timingSafeEqual` to prevent timing attacks.

4. **Hardened Swaps**: Syntax errors or boot timeouts in pushed code trigger a fallback to the previous working version. The kernel uses exponential backoff to verify socket readiness.

5. **Self-Healing State**: On boot, the kernel auto-commits tracked file modifications to restore push-to-deploy capability, while ignoring untracked Soil to protect Git history.

6. **Stateless Identity (FIP)**: Device identity is verified via HMAC-SHA256 at the edge. No session stores, no JWT bloat, no centralized user databases.

7. **Filesystem Mycelium**: User identity flows through the kernel's in-memory map, fed by atomic writes to `/users.json`. Zero network overhead for identity resolution.

### The Threat Model

git-forest assumes:
- **You own the container**: Physical or virtual access means full control (as it should be)
- **The network is hostile**: All external input is validated, all secrets are timing-safe
- **Components are untrusted**: Each component runs in its own process, isolated by Unix sockets
- **Git is the source of truth**: If the filesystem is corrupted, Git history can restore it

---

## XI. The Declaration

We hold these truths to be self-evident:

1. **Software should be owned**, not rented. When you deploy to a platform you do not control, you are a tenant, not an owner.

2. **Complexity should be earned**, not imposed. Every abstraction layer should justify its existence. Most do not.

3. **The filesystem is the universal interface**. Plain text is readable by humans, parseable by machines, and diffable by Git. It is the most successful data format in history.

4. **Autonomy requires autonomic systems**. Software that requires constant human intervention is not sovereign. Software that tends itself is.

5. **Seeds should be portable**. A component specification should be reproducible anywhere, by anyone, without proprietary toolchains.

6. **Identity should be local**. Devices authenticate themselves; people identify themselves. Neither requires a third party.

7. **Simplicity is sufficient**. For 95% of use cases, a text editor, Git, and Node.js are enough. The other 5% have bigger problems than tooling.

8. **Knowledge compounds**. When code and semantics are co-expressed, the system becomes more valuable over time, not less.

`git-forest` is not a revolution. It is a return — to a time when software was small, understandable, and owned by the people who ran it.

You are not building software. You are planting a forest.

---

*Plant the seed. Watch the forest grow.* 🌲