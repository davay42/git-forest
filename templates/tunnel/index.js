#!/usr/bin/env node
// tunnel/index.js - Zero-dependency WebSocket Tunnel
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { randomBytes } from 'node:crypto';

// Add this at the very top of tunnel/index.js, before the server creation
console.log('[tunnel] Component starting...');

const TUNNEL_SECRET = process.env.TUNNEL_SECRET || process.env.FOREST_COMPONENT_TOKEN;

// ─── NATIVE WEBSOCKET IMPLEMENTATION ──────────────────────────────────────
const MAGIC_STRING = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class WebSocket {
  constructor(socket) {
    this.socket = socket;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parseFrames();
    });

    socket.on('close', () => {
      if (this.onclose) this.onclose();
    });

    socket.on('error', (err) => {
      if (this.onerror) this.onerror(err);
    });
  }

  parseFrames() {
    while (this.buffer.length > 0) {
      const frame = this.parseFrame(this.buffer);
      if (!frame) break;

      this.buffer = this.buffer.subarray(frame.totalLength);

      if (frame.opcode === 0x1) { // Text frame
        if (this.onmessage) this.onmessage(frame.payload.toString(), false);
      } else if (frame.opcode === 0x2) { // Binary frame
        if (this.onmessage) this.onmessage(frame.payload, true);
      } else if (frame.opcode === 0x8) { // Close frame
        this.socket.end();
        return;
      }
    }
  }

  parseFrame(buffer) {
    if (buffer.length < 2) return null;

    const firstByte = buffer[0];
    const secondByte = buffer[1];

    const opcode = firstByte & 0x0f;
    const isMasked = (secondByte & 0x80) === 0x80;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (buffer.length < 4) return null;
      payloadLength = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (buffer.length < 10) return null;
      payloadLength = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    let maskingKey = null;
    if (isMasked) {
      if (buffer.length < offset + 4) return null;
      maskingKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buffer.length < offset + payloadLength) return null;

    const payload = Buffer.alloc(payloadLength);
    for (let i = 0; i < payloadLength; i++) {
      payload[i] = buffer[offset + i] ^ (maskingKey ? maskingKey[i % 4] : 0);
    }

    return { opcode, payload, totalLength: offset + payloadLength };
  }

  send(data) {
    const isString = typeof data === 'string';
    const payload = isString ? Buffer.from(data) : data;
    const opcode = isString ? 0x1 : 0x2;
    const length = payload.length;

    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    this.socket.write(Buffer.concat([header, payload]));
  }

  close() {
    this.socket.end();
  }
}

function handleWebSocketUpgrade(req, socket, head, onConnection) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + MAGIC_STRING)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  const ws = new WebSocket(socket);
  onConnection(ws);
}

// ─── TUNNEL LOGIC ─────────────────────────────────────────────────────────
let localClient = null;
const pendingRequests = new Map();
const activeStreams = new Map();

function handleLocalConnection(ws) {
  console.log('[tunnel] Local client connected');
  localClient = ws;

  ws.onmessage = (data, isBinary) => {
    if (isBinary) {
      const requestId = data.subarray(0, 4).toString('hex');
      const payload = data.subarray(4);
      const stream = activeStreams.get(requestId);
      if (stream) stream.res.write(payload);
    } else {
      try {
        const message = JSON.parse(data);
        handleMessage(message);
      } catch (err) {
        console.error('[tunnel] Parse error:', err);
      }
    }
  };

  ws.onclose = () => {
    console.log('[tunnel] Local client disconnected');
    localClient = null;
    pendingRequests.clear();
    activeStreams.clear();
  };
}

function handleMessage(message) {
  if (message.type === 'response-start') {
    const pending = pendingRequests.get(message.id);
    if (pending) {
      pending.resolve(message);
    }
  } else if (message.type === 'response-end') {
    const stream = activeStreams.get(message.id);
    if (stream) {
      stream.res.end();
      activeStreams.delete(message.id);
    }
  }
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check (accessed via /tunnel/health)
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: !!localClient,
      pending: pendingRequests.size,
      active: activeStreams.size
    }));
    return;
  }

  // Main tunnel endpoint - proxy EVERYTHING else to the local machine
  if (!localClient) {
    res.writeHead(503, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
      <body style="font-family: system-ui; text-align: center; margin-top: 5rem; color: #333;">
        <h1>🚪 Tunnel Disconnected</h1>
        <p>The local machine is not currently connected to the tunnel.</p>
        <p style="color: #666; font-size: 0.9rem;">Run <code style="background:#eee; padding:2px 6px; border-radius:4px;">node local-tunnel-client.js</code> on your laptop to open the door.</p>
      </body>
      </html>
    `);
    return;
  }

  const requestId = randomBytes(4).toString('hex');

  // The Core has already stripped the /tunnel prefix.
  // So /tunnel/test becomes /test, /tunnel/ becomes /
  const localPath = url.pathname + url.search;

  req.on('data', (chunk) => {
    localClient.send(Buffer.concat([Buffer.from(requestId, 'hex'), chunk]));
  });

  req.on('end', () => {
    localClient.send(JSON.stringify({
      type: 'request',
      id: requestId,
      method: req.method,
      path: localPath,
      headers: req.headers
    }));
  });

  activeStreams.set(requestId, { res });

  const responsePromise = new Promise((resolve) => {
    pendingRequests.set(requestId, { resolve, res });
  });

  responsePromise.then((response) => {
    const headers = { ...response.headers };

    // 🚀 CRITICAL FIX: Rewrite Location headers to keep redirects inside the tunnel
    if (headers.location) {
      let location = headers.location;
      // If the local server issues an absolute path redirect (e.g., /test -> /test/)
      // we must prepend /tunnel so the browser requests /tunnel/test/ instead of escaping to /test/
      if (location.startsWith('/')) {
        headers.location = '/tunnel' + location;
      }
    }

    res.writeHead(response.status, headers);
  }).catch(() => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Tunnel error');
    }
  });

  setTimeout(() => {
    if (pendingRequests.has(requestId)) {
      if (!res.headersSent) {
        res.writeHead(504);
        res.end('Gateway timeout');
      }
      pendingRequests.delete(requestId);
      activeStreams.delete(requestId);
    }
  }, 60000);
});

server.on('request', (req, res) => {
  console.log('[tunnel] HTTP request:', req.method, req.url);
});

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
  console.log('[tunnel] 📡 Upgrade request received');
  console.log('[tunnel] URL:', req.url);
  console.log('[tunnel] Headers:', req.headers);

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    console.log('[tunnel] Parsed URL:', url.pathname);

    if (url.pathname === '/ws') {
      const secret = url.searchParams.get('secret');
      console.log('[tunnel] Checking secret:', secret ? '[present]' : '[missing]');

      if (secret !== TUNNEL_SECRET) {
        console.log('[tunnel] ❌ Invalid secret');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      console.log('[tunnel] ✅ Secret valid, performing handshake');
      handleWebSocketUpgrade(req, socket, head, handleLocalConnection);
    } else {
      console.log('[tunnel] ❌ Unknown path:', url.pathname);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  } catch (err) {
    console.error('[tunnel] ❌ Upgrade handler error:', err);
    console.error('[tunnel] Stack:', err.stack);
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
});

server.listen(process.env.SOCKET_PATH, () => {
  console.log(`[tunnel] Zero-dependency tunnel ready on ${process.env.SOCKET_PATH}`);
  if (process.send) process.send('ready'); // Signal the Core that we are alive!
});

// Signal ready to the git-forest core
if (process.send) {
  process.send('ready');
}