# 🚪 Tunnel

A zero-dependency, transparent HTTP and WebSocket reverse proxy for `git-forest`. 

Tunnel allows you to expose your local `git-forest` instance (running on your laptop) to the public internet via your VPS, without relying on third-party services like ngrok, Cloudflare, or localtunnel.

## Philosophy

The modern internet is full of complex, subscription-based tunneling services. But at its core, a tunnel is just a reverse proxy that holds a persistent connection open. 

This component is built entirely with native Node.js modules (`node:http`, `node:net`, `node:crypto`). It has zero `npm` dependencies. It handles standard HTTP requests, Server-Sent Events (SSE), and WebSocket upgrades seamlessly.

## Architecture

1. **The VPS (Public Internet):** Runs the `tunnel` component inside your production `git-forest`. It listens for a WebSocket connection from your laptop.
2. **The Local Client (Your Laptop):** Runs a standalone script that connects to the VPS via WebSocket and proxies incoming traffic to your local `localhost:3000`.

When a user visits `https://your-vps.com/tunnel/poll`, the VPS Core routes the request to the `tunnel` component. The component forwards it over the WebSocket to your laptop. Your local `git-forest` processes the request, sends the response back over the WebSocket, and the VPS serves it to the user.

## Usage

### 1. VPS Setup

Add the `tunnel` component to your production forest:

```bash
mkdir tunnel
# Add the tunnel/index.js file
git add tunnel/
git commit -m "Add tunnel component"
git push
```

Set a secure secret in your deployment environment (e.g., Coolify, Docker, systemd):

```bash
TUNNEL_SECRET=your-secure-random-string
```

### 2. Local Client Setup

On your laptop, create a `local-tunnel-client.js` file (using native Node.js `http`/`https` and `crypto` modules) and run it:

```bash
export TUNNEL_URL=wss://your-vps.com/tunnel/ws
export TUNNEL_SECRET=your-secure-random-string
export LOCAL_PORT=3000

node local-tunnel-client.js
```

### 3. Access Your Local Forest

Start your local forest on port 3000:

```bash
npx @davay/git-forest
```

Your local components are now accessible to the world:

- Local: `http://localhost:3000/poll`
- Public: `https://your-vps.com/tunnel/poll`

When you are done, simply `Ctrl+C` the local client script. The tunnel closes instantly, and your local machine is no longer accessible from the internet.

## Features

- **Transparent Proxy:** Forwards HTTP, SSE, and WebSocket traffic seamlessly.
- **Redirect Rewriting:** Automatically rewrites `Location` headers in 3xx responses to prevent requests from "escaping" the tunnel.
- **Ephemeral Security:** The public internet can only reach your laptop while the client script is actively running.
- **Zero Dependencies:** Uses only native Node.js primitives.
