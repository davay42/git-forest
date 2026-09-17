# git-forest

> A zero-dependency Node.js runtime where the filesystem is the router, directories are isolated components, and Git is the deployment mechanism. 
> *(Note: This is a standalone application server and Micro-PaaS, not a Git CLI plugin).*

## The Philosophy

Modern web development requires a framework, a database, a process manager, and a complex CI/CD pipeline. **git-forest** is a reaction against this bloat. 

It distills application architecture down to its absolute primitives:
- **The Filesystem is the Router:** No configuration files. If a directory exists, it's a route.
- **Directories are Components:** A folder containing an `index.js` is an isolated, self-contained application component.
- **Processes are Workers:** The core orchestrator spawns a separate, isolated Node.js worker for each component, communicating via Unix domain sockets. If one crashes, the others keep running.
- **Git is the Database and Deployment:** State is just files on disk. `git push` deploys code, data, and schema simultaneously. The server itself acts as the Git remote.

All of this is achieved in ~200 lines of pure Node.js, using **zero external dependencies**.

---

## Architecture & Mental Model

| Concept | Description |
| :--- | :--- |
| **Core Orchestrator** | The `index.js` file at the root. It watches the filesystem, spawns workers, proxies HTTP requests, handles security, and serves the Git HTTP backend. |
| **Component** | Any root-level directory containing an `index.js`. It represents a distinct feature or route (e.g., `/poll`, `/journal`). |
| **Worker** | The isolated Node.js process spawned by the core to run a specific component. Workers communicate with the core via Unix domain sockets (`/tmp/forest-<name>.sock`). |
| **Static Assets** | Any root-level directory *without* an `index.js` (e.g., `/public`, `/images`). The core serves these files directly. |


### How Routing Works
The core automatically strips the component name from the URL. 
If a user visits `/poll/vote`, the core proxies the request to the `poll` worker with the path `/vote`. **Components are entirely path-agnostic.** You can rename the `poll` directory to `survey`, and the code inside requires zero changes.

---

## Local Development

### macOS Setup

On macOS, the Git HTTP backend binary location varies depending on how Git was installed. git-forest automatically discovers the correct path, but you can override it if needed:

```bash
# Option 1: Let git-forest auto-discover (recommended)
node index.js

# Option 2: Explicitly set the path if auto-discovery fails
export GIT_HTTP_BACKEND="/opt/homebrew/libexec/git-core/git-http-backend"  # Homebrew Apple Silicon
# or
export GIT_HTTP_BACKEND="/usr/local/libexec/git-core/git-http-backend"     # Homebrew Intel
# or
export GIT_HTTP_BACKEND="/Library/Developer/CommandLineTools/usr/libexec/git-core/git-http-backend"  # Xcode CLT
node index.js
```

Common Git installation paths on macOS:
- **Homebrew (Apple Silicon)**: `/opt/homebrew/libexec/git-core/git-http-backend`
- **Homebrew (Intel)**: `/usr/local/libexec/git-core/git-http-backend`
- **Xcode Command Line Tools**: `/Library/Developer/CommandLineTools/usr/libexec/git-core/git-http-backend`
- **Official Git Installer**: `/usr/local/git/libexec/git-core/git-http-backend`

### Linux/Alpine Setup

On Linux and Alpine, the standard path is typically `/usr/libexec/git-core/git-http-backend`, which git-forest uses as the default fallback.

### Environment Variables

- `PORT`: HTTP server port (default: 3000)
- `GIT_SECRET`: Required for Git push/pull authentication over HTTP
- `TRUST_PROXY`: Set to `1` if behind a reverse proxy (Traefik, Caddy, etc.)
- `GIT_HTTP_BACKEND`: Optional override for Git HTTP backend binary path

---

## Production Bootstrap Sequence (Coolify / Docker)

To run `git-forest` reliably on the open internet, you must bootstrap the container environment correctly. Because the server *is* the Git repository, it requires a persistent volume and specific Git configurations.

### 1. The Dockerfile
Bake `git` and `git-daemon` (required for the HTTP backend on Alpine) into the image for instant boot times.

```dockerfile
FROM node:22-alpine
# git-daemon contains the git-http-backend binary required for push/pull over HTTP
RUN apk add --no-cache git git-daemon
WORKDIR /app
CMD ["node", "index.js"]
```

### 2. The Volume & Environment
In your deployment platform (e.g., Coolify), configure the following:
- **Persistent Volume:** Mount a volume to `/app`. This ensures your Git history, code, and component state survive container restarts.
- **Environment Variables:** 
  - `PORT=3000`
  - `GIT_SECRET=<generate_a_strong_random_string>` (Used for HTTP Basic Auth on the `/git` endpoint).

### 3. First-Time Container Initialization
When you first deploy the container and open the terminal, you must initialize the Git repository and configure it to accept pushes to the active working tree:

```bash
# 1. Initialize the repo
git init
git config user.email "forest@local"
git config user.name "Forest Server"

# 2. CRITICAL: Allow pushing to the checked-out branch
# Without this, git push will fail with "refusing to update checked out branch"
git config receive.denyCurrentBranch updateInstead

# 3. Install the Smart Deploy Hook (see section below)
mkdir -p .git/hooks
# ... paste the post-receive hook script here ...
chmod +x .git/hooks/post-receive
```

---

## The Smart Deploy Hook (Zero-Downtime vs. Restart)

The magic of `git-forest` lies in its `post-receive` Git hook. It inspects *what* was pushed and decides how to deploy it:

1. **Component Update:** If you only change files inside component folders (e.g., `poll/index.js`), the hook sends a `SIGHUP` signal to the core. The core performs a **zero-downtime Blue/Green socket swap**, spinning up the new worker and gracefully retiring the old one without dropping active HTTP requests.
2. **Core Update:** If you change the root `index.js` (the orchestrator itself), the hook sends a `SIGTERM` signal. The core gracefully closes the HTTP server and exits. Docker instantly restarts the container with the new core logic.

**`.git/hooks/post-receive`**
```bash
#!/bin/sh
while read oldrev newrev refname; do
    if [ "$oldrev" = "0000000000000000000000000000000000000000" ]; then
        echo "[deploy] 🌱 New branch pushed. Triggering hot reload..."
        kill -HUP 1
        continue
    fi

    if [ "$newrev" = "0000000000000000000000000000000000000000" ]; then
        continue
    fi

    # Check if the CORE file was modified in this push
    if git diff --name-only $oldrev $newrev | grep -q "^index.js$"; then
        echo "[deploy] 🛠️ Core orchestrator updated. Triggering container restart..."
        kill -TERM 1
        exit 0 
    else
        echo "[deploy] 🌿 Components updated. Triggering zero-downtime hot reload..."
        kill -HUP 1
    fi
done
```

---

## Component Authoring Guide

To ensure components integrate seamlessly with the core's zero-downtime swapping and reverse-proxy routing, follow these rules:

### 1. The Zero-Downtime Lifecycle
Components must listen for `SIGTERM` to finish active requests before dying, and send an IPC `'ready'` message when they have bound to their socket.

```javascript
import { createServer } from 'node:http';

const server = createServer((req, res) => { /* ... */ });

// Graceful Shutdown
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref(); // Force exit fallback
});

// Signal readiness to the Core Orchestrator
server.listen(process.env.SOCKET_PATH, () => {
  if (process.send) process.send('ready');
});
```

### 2. The Trailing Slash Rule
Because the core acts as a reverse proxy, relative URLs in your HTML can break if the user visits `/poll` instead of `/poll/`. 
**Fix:** The core automatically redirects `/component` to `/component/`. Always use relative paths in your HTML (e.g., `<form action="./vote">`) rather than absolute paths.

### 3. Data as Code (Git Commits)
Components can write state to the filesystem (e.g., Markdown, JSON, SQLite). To make this state visible to developers pulling the repo, the component should commit its own data changes.

```javascript
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);

async function commitData(message) {
  // Stage and commit silently. 
  // This does NOT trigger a restart or hot-reload.
  await execAsync(`git add . && git diff --staged --quiet || git commit -m "${message}"`);
}
```
*Note: For high-volume write components, debounce the `commitData` function to prevent Git lock contention.*

---

## Observability & Health Checks

### Public Health Endpoint

git-forest includes a simple public health check endpoint at `/_forest/health`:

```bash
curl http://localhost:3000/_forest/health
# Returns: OK
```

This endpoint is designed for external monitoring systems (Coolify, load balancers, etc.) and requires no authentication. It returns a simple "OK" response to indicate the server is running.

### Internal Status Endpoint

For detailed system information accessible only to components, use `/_forest/status`:

```javascript
// Inside a component, using the component token
const res = await fetch(`http://localhost:${process.env.FOREST_CORE_PORT}/_forest/status`, {
  headers: { 'x-forest-token': process.env.FOREST_COMPONENT_TOKEN }
});
const status = await res.json();
```

This returns detailed JSON with:
- `status`: Overall health status
- `uptime`: Server uptime in milliseconds and human-readable format
- `components`: List of active components with their PID, socket path, and uptime
- `component_count`: Number of active components
- `git_auth_enabled`: Whether Git authentication is configured
- `proxy_trust_enabled`: Whether proxy trust is enabled
- `git_http_backend`: Path to the Git HTTP backend binary
- `is_reloading`: Whether a hot reload is currently in progress
- `requested_by`: Name of the component requesting the status

This endpoint is protected by the component token system and is intended for internal monitoring and debugging.

### Coolify Integration

For Coolify container health monitoring, configure the health check path as `/_forest/health`:

```bash
# In Coolify container settings
Health Check Path: /_forest/health
Health Check Interval: 30s
```

The public health endpoint is intentionally simple and safe - it costs nothing to abuse and provides no sensitive information, making it perfect for external monitoring.

---

## Security & Edge Cases

The core orchestrator includes several production-hardened security features:

1. **Timing-Safe Auth:** The `GIT_SECRET` is validated using `crypto.timingSafeEqual` to prevent side-channel timing attacks on the password.
2. **Rate Limiting:** Failed Git authentication attempts are rate-limited per IP (via `X-Forwarded-For`) to prevent brute-force attacks.
3. **Static File Hardening:** The core explicitly blocks HTTP access to `.git/`, `.env`, `Dockerfile`, and the root `index.js` to prevent source code and secret leakage.
4. **Global Error Boundary:** The HTTP server is wrapped in a `try/catch` block. Malformed HTTP requests from bots will result in a `500` response, but will never crash the core orchestrator.

### The "Developer vs. Data" Collision
Because the server commits data to Git, your local branch may fall behind the remote. 
**The Golden Rule:** Always run `git pull --rebase` locally before pushing new code to ensure you don't overwrite data committed by the live server. For extremely high-churn data (like chat logs), add the data file to `.gitignore` and rely purely on the persistent Docker volume.

---

## Why Build This?

This pattern is frequently reinvented inside mid-to-large tech companies when platform teams grow tired of Kubernetes and Terraform overhead for internal tools. It is rarely shared because it is considered "boring plumbing."

**git-forest** distills this private pattern into a public, zero-dependency primitive. It is not a framework. It is a new way to structure software where the boundary between code, data, and infrastructure completely dissolves.

**Plant the seed. Watch the forest grow.** 🌲