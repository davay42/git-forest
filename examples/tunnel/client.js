#!/usr/bin/env node
// local-tunnel-client.js - Zero-dependency WebSocket client (HTTPS version)
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import crypto from 'node:crypto';

const TUNNEL_URL = process.env.TUNNEL_URL || 'wss://forest.defucc.me/tunnel/ws';
const TUNNEL_SECRET = process.env.TUNNEL_SECRET;
const LOCAL_PORT = parseInt(process.env.LOCAL_PORT || '3000');

if (!TUNNEL_SECRET) {
  console.error('TUNNEL_SECRET environment variable is required');
  process.exit(1);
}

let socket = null;
let reconnectAttempts = 0;

function connect() {
  const url = new URL(TUNNEL_URL);
  url.searchParams.set('secret', TUNNEL_SECRET);

  const isSecure = url.protocol === 'wss:';
  const requestFn = isSecure ? httpsRequest : httpRequest;

  const key = crypto.randomBytes(16).toString('base64');

  const options = {
    hostname: url.hostname,
    port: url.port || (isSecure ? 443 : 80),
    path: url.pathname + url.search,
    method: 'GET',
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      'Host': url.host
    }
  };

  console.log(`[client] Connecting to ${url.host}${url.pathname}...`);

  const req = requestFn(options, (res) => {
    console.error(`[client] HTTP error: ${res.statusCode}`);
    reconnect();
  });

  req.on('upgrade', (res, sock, head) => {
    socket = sock;
    console.log('[client] Connected to tunnel');
    reconnectAttempts = 0;

    sock.on('data', (chunk) => {
      handleWebSocketData(chunk);
    });

    sock.on('close', () => {
      console.log('[client] Disconnected');
      reconnect();
    });

    sock.on('error', (err) => {
      console.error('[client] Socket error:', err.message);
    });
  });

  req.on('error', (err) => {
    console.error('[client] Request error:', err.message);
    reconnect();
  });

  req.end();
}

let buffer = Buffer.alloc(0);
const activeRequests = new Map();

function handleWebSocketData(chunk) {
  buffer = Buffer.concat([buffer, chunk]);

  while (buffer.length > 0) {
    const frame = parseFrame(buffer);
    if (!frame) break;

    buffer = buffer.subarray(frame.totalLength);

    if (frame.opcode === 0x1) { // Text frame
      try {
        const message = JSON.parse(frame.payload.toString());
        if (message.type === 'request') {
          handleRequest(message);
        }
      } catch (err) {
        console.error('[client] Parse error:', err);
      }
    } else if (frame.opcode === 0x2) { // Binary frame
      const requestId = frame.payload.subarray(0, 8).toString('hex');
      const chunk = frame.payload.subarray(8);
      const stream = activeRequests.get(requestId);
      if (stream) stream.req.write(chunk);
    } else if (frame.opcode === 0x8) { // Close frame
      socket.end();
      return;
    }
  }
}

function parseFrame(buffer) {
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

function sendFrame(data, opcode) {
  const isString = typeof data === 'string';
  const payload = isString ? Buffer.from(data) : data;
  const length = payload.length;

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | length; // Masked
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  // Add masking key
  const maskingKey = crypto.randomBytes(4);
  const maskedPayload = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    maskedPayload[i] = payload[i] ^ maskingKey[i % 4];
  }

  socket.write(Buffer.concat([header, maskingKey, maskedPayload]));
}

function handleRequest(message) {
  const { id, method, path, headers } = message;
  console.log(`[client] ${method} ${path}`);

  const options = {
    hostname: 'localhost',
    port: LOCAL_PORT,
    path: path,
    method: method,
    headers: { ...headers }
  };

  delete options.headers.host;
  delete options.headers['connection'];
  delete options.headers['upgrade'];

  const localReq = httpRequest(options, (localRes) => {
    sendFrame(JSON.stringify({
      type: 'response-start',
      id: id,
      status: localRes.statusCode,
      headers: localRes.headers
    }), 0x1);

    localRes.on('data', (chunk) => {
      sendFrame(Buffer.concat([Buffer.from(id, 'hex'), chunk]), 0x2);
    });

    localRes.on('end', () => {
      sendFrame(JSON.stringify({
        type: 'response-end',
        id: id
      }), 0x1);
      activeRequests.delete(id);
    });
  });

  localReq.on('error', (err) => {
    sendFrame(JSON.stringify({
      type: 'response-start',
      id: id,
      status: 502,
      headers: { 'content-type': 'text/plain' }
    }), 0x1);
    sendFrame(Buffer.concat([Buffer.from(id, 'hex'), Buffer.from('Bad Gateway')]), 0x2);
    sendFrame(JSON.stringify({ type: 'response-end', id: id }), 0x1);
  });

  activeRequests.set(id, { req: localReq });
  localReq.end();
}

function reconnect() {
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  setTimeout(connect, delay);
}

connect();

process.on('SIGINT', () => {
  console.log('\n[client] Shutting down...');
  if (socket) socket.end();
  process.exit(0);
});