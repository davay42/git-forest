[d] <https://github.com/davay42/>
[gf] <d:git-forest/>

# git-forest {=gf: .prov:Organization label}

> A zero-dependency Node.js runtime where the filesystem is the database, directories are autonomous agents, and Git is the arrow of time. {comment}

A forest is a sovereign knowledge ecosystem. It runs on a shared filesystem substrate, grows as a Git repository, and is composed of autonomous software agents — directories containing an `index.js` — that coordinate through files and converse with visitors through HTTP.

Every forest is unique. What makes them forests is a shared kernel — a single Node.js process with no dependencies that provides the membrane, the memory, the identity, and the lifecycle. Everything else — the components, the ontologies, the knowledge — belongs to the author.

## Author & Purpose

Made by **davay42** {+d: .prov:Person ?prov:actedOnBehalfOf label} as a personal project exploring sovereign, self-describing software. The kernel exists to make software **ownable, understandable, and evolvable** — the kind of system a single person can run, read, and grow without permission from anyone.

> To provide a minimal, extensible runtime that enables the creation of self-describing knowledge ecosystems. The kernel is not an application — it is a substrate on which applications grow as composed agents. {gf:purpose}

## The Kernel Agent {=gf:kernel .prov:SoftwareAgent label}

The kernel is the foundational agent for the forest of any kind of digital [organization] {+prov:Organization ?prov:actedOnBehalfOf}. It is a single Node.js process with zero dependencies, implemented in [./index.js](./index.js). It wakes up, heals its Git state, discovers its [components] {+prov:SoftwareAgent ?gf:kernel/discovers}, and begins listening on the configured port. From that moment, it performs four kinds of work — continuously, rhythmically, without being asked. The author assigns [Roles] {=prov:Role ?prov:hadRole} to the Agent and it executes them according to the [Plan] {+prov:Plan ?prov:hadPlan}.

### Role Contract {=prov:Role .Class}

Every role the kernel plays is described by six properties. Together they form the complete interface contract:

### Has a Trigger {=gf:hasTrigger !domain .rdf:Property label} 
> What invokes this role: an HTTP method + path, internal interval, signal, or boot event. {comment}
Plain [text] {+xsd:string ?range} descriptor - paths, time spans, signals, observation criteria:

#### Had Plan {=prov:hadPlan .rdf:Property label}
> Step-by-step algorithm description — the teachback safeguard. {comment}
Defined inline as a `prov:Plan` [plan] {+prov:Plan ?range} with a hashed IRI, attached to a [role] {+prov:Role ?domain} via `prov:hadRole` → `prov:hadPlan`.

#### Has Path {=gf:hasPath .rdf:Property label}
> The exact file path and line number where this role's implementation lives. {comment}
[text] {+xsd:string ?range} path to the exact place where the executable code lives[Role] {+prov:Role ?domain}
Range: 

#### Expects Input {=gf:expectsInput .rdf:Property label}
> What the role reads: headers, body, filesystem, query parameters. {comment}
Domain: [Role] {+prov:Role ?domain}
Range: [text] {+xsd:string ?range}

#### Generates Output {=gf:generatesOutput .rdf:Property label}
> What the role writes: HTTP response, files, side effects, events. {comment}
Domain: [Role] {+prov:Role ?domain}
Range: [text] {+xsd:string ?range}

#### Requires Prerequisite {=gf:requiresPrerequisite .rdf:Property label}
> What must be true before the role can execute: auth, access, state. {comment}
Domain: [Role] {+prov:Role ?domain}
Range: [text] {+xsd:string ?range}

---

## Act I: Meeting the World

> Before the kernel can do anything, visitors must reach it.

The [kernel] {=gf:kernel} speaks four protocols and decides, for every incoming byte, where it goes. By default it serves [static files] {+gf:kernel/serveStatic ?prov:hadRole} from public/ directory and works as [git backend] {+gf:kernel/gitBackend ?prov:hadRole} so it can instantly be used for [component routing] {+gf:kernel/routeToComponent ?prov:hadRole}, [websocket] {+gf:kernel/wsUpgrade ?prov:hadRole}.

### Serve Static Content Role {=gf:kernel/serveStatic .prov:Role label}
> Serves files from the `public/` directory as the forest's ground cover. {comment}

[GET /{path}] {gf:hasTrigger}
[./index.js#L389] {gf:hasPath}
[File path from URL] {gf:expectsInput}
[File content with MIME type] {gf:generatesOutput}
[File exists in public/ and path is not a blocked name (.git, .env, .DS_Store)] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Parse URL path, decode URI, strip leading slashes
2. Join with PUBLIC_DIR, validate result starts with PUBLIC_DIR
3. Reject segments in blocked names list
4. stat() the file; if directory, try index.html inside
5. Read content, determine MIME type from extension
6. Return 200 with Content-Type header
7. At root path with no index: return fallback landing page
8. Elsewhere: return 404
~~~~~~

### Route to Component Role {=gf:kernel/routeToComponent .prov:Role label}
> Routes requests to the appropriate component agent based on URL prefix or subdomain. {comment}

[ANY /{component}/* or {component}.domain.com/*] {gf:hasTrigger}
[./index.js#L612] {gf:hasPath}
[Full HTTP request with injected x-forest-device-id and x-forest-user-id headers] {gf:expectsInput}
[Component's HTTP response streamed back to visitor] {gf:generatesOutput}
[Component exists with running process on Unix socket] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Extract component name from first path segment or subdomain
2. Look up component in the components Map
3. If path matches component exactly without trailing slash, 301 redirect
4. Strip component prefix from URL
5. Inject identity headers from kernel state
6. Create proxy request to component's Unix socket
7. Stream response back to visitor
8. On socket error, return 502 Bad Gateway
~~~~~~

### Handle Git HTTP Backend Role {=gf:kernel/gitBackend .prov:Role label}
> Acts as a Git smart HTTP server for push-to-deploy and cloning. {comment}

[ANY /git/*] {gf:hasTrigger}
[./index.js#L527] {gf:hasPath}
[Git protocol HTTP request with optional Basic auth] {gf:expectsInput}
[Git protocol HTTP response with correct CGI headers] {gf:generatesOutput}
[Valid Basic auth credentials if GIT_SECRET is set] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Check rate limiting on client IP
2. If GIT_SECRET set, validate Basic auth with timing-safe comparison
3. On failure, record attempt and return 401/403
4. Build environment: GIT_PROJECT_ROOT, GIT_DIR, PATH_INFO, REMOTE_USER
5. Spawn git-http-backend process
6. Pipe request body for POST requests
7. Buffer stdout until \r\n\r\n separator
8. Parse CGI headers, extract Status code
9. Write headers to visitor, stream remaining output
~~~~~~

### Handle WebSocket Upgrade Role {=gf:kernel/wsUpgrade .prov:Role label}
> Upgrades connections to WebSocket and proxies bidirectional data to component sockets. {comment}

[UPGRADE /{component}/*] {gf:hasTrigger}
[./index.js#L684] {gf:hasPath}
[HTTP upgrade request with WebSocket headers] {gf:expectsInput}
[Bidirectional WebSocket data stream] {gf:generatesOutput}
[Component exists and accepts connections] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Process identity for non-internal requests
2. Extract component from first path segment
3. If not found, write 404 and destroy socket
4. Connect to component's Unix socket
5. On connect: reconstruct HTTP upgrade request with stripped path
6. Add x-forest-device-id header if present
7. Write reconstructed request and any buffered head data
8. Pipe visitor socket ↔ component socket bidirectionally
9. Handle errors on either side by cleaning up the other
~~~~~~

---

## Act II: Knowing Who and What

Every conversation needs a subject. [Kernel] {=gf:kernel} maintains three forms of identity: the device (what arrived via [identity processing] {+gf:kernel/processIdentity ?prov:hadRole}), the user (who owns it, managed by [watching the device map] {+gf:kernel/watchDeviceMap ?prov:hadRole} which maintains the [device-user mapping] {+gf:kernel/deviceMap .prov:Entity label}), and the history (what happened, committed via [Git breathing] {+gf:kernel/breatheGit ?prov:hadRole}).

### Process Identity Role {=gf:kernel/processIdentity .prov:Role label}
> Issues and validates device identity cookies using HMAC-SHA256 signatures. {comment}

[Every non-internal HTTP request] {gf:hasTrigger}
[./index.js#L310] {gf:hasPath}
[Incoming cookie header or absence thereof] {gf:expectsInput}
[Set-Cookie header with signed token if needed, x-forest-device-id on request] {gf:generatesOutput}
[None — runs on every request] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Extract forest_session cookie
2. If present, split into deviceId.issuedAt.signature
3. Recompute HMAC-SHA256 with AUTH_SECRET
4. Compare with timingSafeEqual — reject on mismatch
5. If valid, check if issuedAt is older than RENEWAL_WINDOW_DAYS
6. If no valid device, generate new 16-byte random deviceId
7. If renewal needed, build new token and set Set-Cookie header
   with HttpOnly, SameSite=Lax, conditional Secure, Max-Age
8. Attach forestDeviceId to request object
~~~~~~

### Watch Device Map Role {=gf:kernel/watchDeviceMap .prov:Role label}
> Monitors users.json at the forest root and reloads the device→user mapping into the [device-user mapping] {+gf:kernel/deviceMap .prov:Entity label} entity. {comment}

[Boot-time setup + fs.watch on ROOT directory] {gf:hasTrigger}
[./index.js#L361] {gf:hasPath}
[users.json file contents] {gf:expectsInput}
[Updated in-memory deviceUserMap] {gf:generatesOutput}
[None] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. At boot: load users.json, parse JSON, populate deviceUserMap
2. Set up fs.watch on ROOT (works even if file doesn't exist yet)
3. On event with filename 'users.json': wait 100ms for write flush
4. Reload: read file, parse JSON, clear and repopulate map
5. On parse error, log warning but keep existing map
~~~~~~

### Breathe Git Changes Role {=gf:kernel/breatheGit .prov:Role label}
> Autonomically commits filesystem changes to Git history on a 5-second cycle. {comment}

[Internal interval every BREATH_MS (default 5000ms)] {gf:hasTrigger}
[./index.js#L198] {gf:hasPath}
[Current git working directory state] {gf:expectsInput}
[Git commit with semantic message describing changes] {gf:generatesOutput}
[Dirty git status detected] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Run git status --porcelain
2. If dirty: set sleepState to 'awake', reset activity timer, increment breathCount
3. Run git add -A
4. Run git diff --staged --name-only
5. If no staged files, return
6. Analyze file paths to derive semantic commit message:
   - Code changes (index.js) → "deploy {components}"
   - Knowledge changes (*.md) → "{components} knowledge"
   - User changes (users/) → "user {name}" or "{count} users"
   - Combine segments with " · "
7. Run git commit -m with derived message
8. Increment commitCount, log the breath
~~~~~~

### Introspect Role {=gf:kernel/introspect .prov:Role label}
> Enters sleep states during quiet periods, consolidating changes and running maintenance. {comment}

[Internal trigger after SLEEP_AFTER_MS (5min) or DEEP_SLEEP_AFTER_MS (1hr)] {gf:hasTrigger}
[./index.js#L254] {gf:hasPath}
[Quiet duration since last activity] {gf:expectsInput}
[Consolidated git state, optional deep maintenance] {gf:generatesOutput}
[Sufficient quiet period elapsed] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Log introspect entry with uptime, breath count, commit count
2. Run git status --porcelain
3. If dirty, add and commit "chore: sleep consolidation"
4. Run git gc --auto for routine collection
5. If GIT_BACKUP_URL configured, call syncToBackup
6. If deep sleep: run git reflog expire and git repack
7. Log uptime for each active component
~~~~~~

---

## Act III: Growing the Forest

[kernel] {=gf:kernel} grows its canopy not by deployment but by discovery. When new code is pushed, [the reload] {+gf:kernel/reload ?prov:hadRole} scans the forest root for directories containing an index.js, and for each one [swaps in a component] {+gf:kernel/swapComponent ?prov:hadRole} — spawning an isolated Node.js process, handing it a fresh Unix socket, and waiting. Readiness is not announced; it is sensed with exponential backoff until the process answers, then the kernel swaps it into the routing table in a single atomic gesture, so no visitor ever meets a half-grown tree. When a tree dies mid-flight, the same [swapComponent] {+gf:kernel/swapComponent ?prov:hadRole} notices and restarts it after a breath. On every push, [ensureGitHook] {+gf:kernel/ensureGitHook ?prov:hadRole} has already prepared the post-receive hook that distinguishes a kernel change from a component change, triggering targeted reloads only where needed. Growth and pruning happen without downtime — the canopy changes while birds are still mid-flight.

### Swap Component Role {=gf:kernel/swapComponent .prov:Role label}
> Spawns a new component process, waits for readiness, then hot-swaps the router. {comment}

[Internal trigger from reload or initial boot] {gf:hasTrigger}
[./index.js#L437] {gf:hasPath}
[Component directory path with valid index.js] {gf:expectsInput}
[Running component process on Unix socket, router updated] {gf:generatesOutput}
[Component directory exists with index.js] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Unlink any stale socket at target path
2. Generate unique socket path: /tmp/forest-{name}-{timestamp}.sock
3. Spawn node process with SOCKET_PATH, COMPONENT_NAME, COMPONENT_DIR,
   FOREST_CORE_PORT as environment
4. Attach exit handler: on non-zero exit, restart after 3s
5. Poll socket with exponential backoff (50ms → 1s cap, 15s timeout)
6. On each attempt: check file exists, try net.connect, resolve on 'connect'
7. If not ready: kill process, log failure, return
8. Add to components Map with socketPath, proc, startTime
9. SIGTERM old process if exists
10. Schedule old socket unlink after COMPONENT_CLEANUP_DELAY_MS
~~~~~~

### Reload Components Role {=gf:kernel/reload .prov:Role label}
> Triggers a hot-reload of component agents, either targeted or full scan. {comment}

[POST /_forest/reload] {gf:hasTrigger}
[./index.js#L596] {gf:hasPath}
[x-forest-token header, optional x-forest-changed-dirs header] {gf:expectsInput}
[200 text response, async reload in background] {gf:generatesOutput}
[Valid token in x-forest-token header] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Validate token via timing-safe comparison
2. If invalid, return 403
3. Parse x-forest-changed-dirs header for targeted list
4. Return 200 immediately
5. In background: scan ROOT directory for component folders
6. For each new/changed component, call swapComponent
7. For each removed component, call killComponent
8. Log completion with active component list
~~~~~~

### Ensure Git Hook Role {=gf:kernel/ensureGitHook .prov:Role label}
> Writes the post-receive hook that triggers targeted reloads on push. {comment}

[Boot sequence, after git init/clone] {gf:hasTrigger}
[./index.js#L784] {gf:hasPath}
[Current RELOAD_TOKEN value] {gf:expectsInput}
[.git/hooks/post-receive script with embedded token] {gf:generatesOutput}
[Git repository exists with .git/hooks directory] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Ensure .git/hooks directory exists
2. Generate shell script that:
   - Reads oldrev/newrev/refname from stdin
   - Skips branch deletions and non-main/master pushes
   - On first push: trigger full reload via curl
   - If index.js changed: kill PID 1 (triggers container restart)
   - Otherwise: extract changed directories, trigger targeted reload
3. Write script with mode 0o755
~~~~~~

### Heal Git State Role {=gf:kernel/healGitState .prov:Role label}
> On boot, auto-commits tracked file modifications to restore push-to-deploy. {comment}

[Boot sequence, before component spawn] {gf:hasTrigger}
[./index.js#L823] {gf:hasPath}
[Git working directory state] {gf:expectsInput}
[Commit of tracked file changes if dirty] {gf:generatesOutput}
[Git repository exists] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Run git status --porcelain
2. If clean, return early
3. Run git add -u (only tracked files)
4. Run git diff --staged --name-only
5. If staged changes exist, commit "chore: auto-heal tracked files after boot"
6. If only untracked files, leave uncommitted to protect history
~~~~~~

---

## Act IV: Breathing and Resting

[Kernel] {=gf:kernel} also lives on a rhythm no visitor ever triggers. Every five seconds it [breathes] {+gf:kernel/breatheGit ?prov:hadRole}: it wakes, looks at the filesystem, and if the working tree is dirty it inhales all changes with git add -A, reads the staged paths, and exhales a single semantic commit — deploy user · catalog knowledge · user alice payments — deriving the message from file structure alone, without any component ever telling it what happened. When five minutes pass without a breath, it [sleeps] {+gf:kernel/introspect ?prov:hadRole}, consolidating orphaned changes and running git gc; after an hour it descends into deep sleep via the same role, pruning the reflog and repacking objects like a body doing cellular maintenance. On boot it [heals itself] {+gf:kernel/healGitState ?prov:hadRole} — committing tracked-file modifications so push-to-deploy still works after an unclean shutdown, while deliberately leaving untracked soil alone. If a backup remote is configured, [new commits are pushed] {+gf:kernel/syncBackup ?prov:hadRole} every five minutes, so the forest's memory exists in more than one place. Monitoring systems can [check health] {+gf:kernel/health ?prov:hadRole} with a simple ping or [query status] {+gf:kernel/status ?prov:hadRole} for detailed metrics about breath state, component uptime, and commit counts. And when the process is asked to die, it [shuts down gracefully] {+gf:kernel/gracefulShutdown ?prov:hadRole}: SIGTERM to every component, drain the HTTP connections, unlink the sockets, exit. The forest does not crash. It exhales. to every component, drain the HTTP connections, unlink the sockets, exit. The forest does not crash. It exhales.

### Check Health Role {=gf:kernel/health .prov:Role label}
> Returns a simple health check response for monitoring systems. {comment}

[GET /_forest/health] {gf:hasTrigger}
[./index.js#L568] {gf:hasPath}
[None] {gf:expectsInput}
[200 OK text response] {gf:generatesOutput}
[None] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Return 200 with Content-Type text/plain and body "OK"
~~~~~~

### Report Status Role {=gf:kernel/status .prov:Role label}
> Returns detailed forest status as JSON for monitoring and debugging. {comment}

[GET /_forest/status] {gf:hasTrigger}
[./index.js#L576] {gf:hasPath}
[None] {gf:expectsInput}
[JSON with uptime, component info, breath state, auth status] {gf:generatesOutput}
[None] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Calculate uptime from startTime
2. Build component info map: socket path, PID, uptime per component
3. Build status object with: uptime, port, component count, git auth,
   proxy trust, git backend path, reload state, breath state/count,
   commit count, device-user mapping count
4. Return 200 with JSON body
~~~~~~

### Sync to Backup Role {=gf:kernel/syncBackup .prov:Role label}
> Pushes new commits to a configured remote backup repository. {comment}

[Initial delay after boot, then every BACKUP_INTERVAL_MS (default 5min)] {gf:hasTrigger}
[./index.js#L653] {gf:hasPath}
[Local git state vs backup remote state] {gf:expectsInput}
[Pushed commits to backup remote] {gf:generatesOutput}
[GIT_BACKUP_URL is set] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Check if 'backup' remote exists via git remote get-url
2. If not, add it with git remote add backup {GIT_BACKUP_URL}
3. Count commits ahead: git rev-list --count backup/main..main
4. If count is 0, skip push
5. Run git push --set-upstream backup main
6. Log success or failure
~~~~~~

### Graceful Shutdown Role {=gf:kernel/gracefulShutdown .prov:Role label}
> Handles SIGTERM/SIGINT by closing the HTTP server and terminating all component processes. {comment}

[Process signal: SIGTERM or SIGINT] {gf:hasTrigger}
[./index.js#L762] {gf:hasPath}
[Signal type] {gf:expectsInput}
[Clean process exit after connections drain] {gf:generatesOutput}
[None — always runs on signal] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Log signal received
2. For each component: send SIGTERM, unlink socket path
3. Call server.close() to stop accepting connections
4. Wait for active connections to finish
5. On completion, exit with code 0
6. Set fallback: if not drained in SHUTDOWN_TIMEOUT_MS, force exit(1)
~~~~~~

---

## Configuration

The kernel reads configuration from environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP server port |
| `GIT_SECRET` | *(none)* | Password for Git push-to-deploy (Basic auth) |
| `TRUST_PROXY` | `0` | Trust X-Forwarded-For header |
| `GIT_BACKUP_URL` | *(none)* | Remote Git URL for periodic backup pushes |
| `RELOAD_TOKEN` | *(random)* | Token for internal reload API calls |
| `AUTH_SECRET` | *(random)* | HMAC key for device identity cookie |
| `AUTH_COOKIE_NAME` | `forest_session` | Cookie name |
| `FOREST_BREATH_MS` | `5000` | Git breathing interval |
| `FOREST_SLEEP_AFTER_MS` | `300000` | Quiet period before sleep |
| `FOREST_DEEP_SLEEP_AFTER_MS` | `3600000` | Quiet period before deep sleep |
| `FOREST_COMPONENT_BOOT_TIMEOUT_MS` | `15000` | Max wait for component socket |
| `FOREST_RATE_LIMIT_MAX` | `5` | Max failed auth per IP per window |
| `FOREST_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `FOREST_PROXY_MAX_SOCKETS` | `128` | Max concurrent proxy connections |
| `FOREST_SHUTDOWN_TIMEOUT_MS` | `5000` | Graceful shutdown timeout |

---

## The Forest Is Self-Describing {=gf:stmt-self-describing .rdf:Statement .prov:Entity label}

**The entire forest** {+gf: ?rdf:subject} *is documented by* {+gf:documentedBy ?rdf:predicate} **its own MD-LD files** {+gf:ontologyFiles ?rdf:object}.

Reading this file reveals the complete kernel: what roles it plays, what they expect, what they produce, and how they work. Reading each component's `index.md` reveals that component's agent, entities, and roles. The ontology is the documentation. No separate manual required.

Generated by: [Kernel Boot] {+gf:kernel ?prov:wasGeneratedBy}
Established: [2026-10-18T00:00:00Z] {prov:generatedAtTime ^^xsd:dateTime}

---

## The Kernel's Philosophy

The kernel is not a framework. It is a **substrate** — a minimal runtime that enables self-describing, sovereign knowledge ecosystems. It provides the membrane, the memory, the identity, and the lifecycle. Everything else belongs to the author.

Every forest is unique. Every forest is owned. Every forest is understandable.

Plant a seed. Watch the forest grow.

🌲