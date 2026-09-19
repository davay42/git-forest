// notify/web-push.js
// Zero-dependency Web Push sender implementing RFC 8030, 8291, 8292, and 8188.
// Uses only node:crypto. No npm packages required.

import crypto from 'node:crypto';

// ─── HKDF (RFC 5869) ───────────────────────────────────────────────────
function hkdfExtract(salt, ikm) {
  return crypto.createHmac('sha256', salt).update(ikm).digest();
}

function hkdfExpand(prk, info, length) {
  let output = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  for (let i = 1; output.length < length; i++) {
    block = crypto.createHmac('sha256', prk)
      .update(Buffer.concat([block, info, Buffer.from([i])]))
      .digest();
    output = Buffer.concat([output, block]);
  }
  return output.subarray(0, length);
}

// ─── VAPID Key Loading (handles both raw scalars and DER) ──────────────
function loadVapidPrivateKey(b64url) {
  const raw = Buffer.from(b64url, 'base64url');
  if (raw.length === 32) {
    // Raw 32-byte scalar → wrap in minimal PKCS#8 DER
    const der = Buffer.concat([
      Buffer.from('30310201010420', 'hex'),
      raw,
      Buffer.from('a00a06082a8648ce3d030107', 'hex'),
    ]);
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  }
  // Already DER-encoded
  return crypto.createPrivateKey({ key: raw, format: 'der', type: 'pkcs8' });
}

// ─── VAPID JWT (RFC 8292) ──────────────────────────────────────────────
function createVapidToken(privateKeyB64url, subject, audience) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + 43200, sub: subject };

  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

  const pem = loadVapidPrivateKey(privateKeyB64url);

  const signature = crypto.sign('SHA256', Buffer.from(signingInput), {
    key: pem,
    dsaEncoding: 'ieee-p1363'
  });

  return `${signingInput}.${signature.toString('base64url')}`;
}

// ─── Payload Encryption (RFC 8291 + RFC 8188 chunking) ─────────────────
function encryptPayload(plaintext, subscription) {
  const clientPublicKey = Buffer.from(subscription.keys.p256dh, 'base64url');
  const clientAuth = Buffer.from(subscription.keys.auth, 'base64url');

  // Ephemeral ECDH key pair
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const serverPublicKey = ecdh.getPublicKey();

  // Shared secret
  const sharedSecret = ecdh.computeSecret(clientPublicKey);

  // Salt
  const salt = crypto.randomBytes(16);

  // IKM = HKDF(auth, ecdh_secret, "WebPush: info\0" || clientPub || serverPub, 32)
  const infoIkm = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    clientPublicKey,
    serverPublicKey
  ]);
  const ikm = hkdfExpand(hkdfExtract(clientAuth, sharedSecret), infoIkm, 32);

  // PRK = HKDF(salt, ikm, "", 32)
  const prk = hkdfExtract(salt, ikm);

  // CEK = HKDF(prk, "Content-Encoding: aes128gcm\0", 16)
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);

  // Base Nonce = HKDF(prk, "Content-Encoding: nonce\0", 12)
  const baseNonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  const RS = 4096;
  const RECORD_MAX = RS - 17; // 4079 bytes per record
  const buf = Buffer.from(plaintext);

  // Guard: push services cap at ~4KB, so we enforce the limit
  if (buf.length > RECORD_MAX * 100) {
    throw new Error('Payload too large for Web Push (>400KB)');
  }

  // Chunk into records per RFC 8188
  const records = [];
  const nRecords = Math.max(1, Math.ceil(buf.length / RECORD_MAX));

  for (let seq = 0; seq < nRecords; seq++) {
    const data = buf.subarray(seq * RECORD_MAX, (seq + 1) * RECORD_MAX);
    const last = seq === nRecords - 1;
    const delimiter = last ? 0x02 : 0x01;
    const record = Buffer.concat([data, Buffer.from([delimiter])]);

    // Nonce = baseNonce XOR seq (96-bit big-endian)
    const nonce = Buffer.from(baseNonce);
    nonce[8] ^= (seq >>> 24) & 0xff;
    nonce[9] ^= (seq >>> 16) & 0xff;
    nonce[10] ^= (seq >>> 8) & 0xff;
    nonce[11] ^= seq & 0xff;

    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const encrypted = Buffer.concat([cipher.update(record), cipher.final()]);
    const tag = cipher.getAuthTag();
    records.push(Buffer.concat([encrypted, tag]));
  }

  // aes128gcm header: salt(16) || rs(4) || idlen(1) || keyid(65)
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RS, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([65]), serverPublicKey]);

  return Buffer.concat([header, ...records]);
}

// ─── Public API ────────────────────────────────────────────────────────
export async function sendWebPush(subscription, payloadString, vapid, options = {}) {
  const endpoint = new URL(subscription.endpoint);
  const audience = `${endpoint.protocol}//${endpoint.host}`;

  const token = createVapidToken(vapid.privateKey, vapid.subject, audience);

  // Empty payload: send unencrypted (silent push)
  if (!payloadString || payloadString.length === 0) {
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${token},k=${vapid.publicKey}`,
        'TTL': String(options.ttl || 86400),
        ...(options.urgency ? { 'Urgency': options.urgency } : {}),
        ...(options.topic ? { 'Topic': options.topic } : {})
      }
    });

    if (!response.ok) {
      const err = new Error(`Push failed: ${response.status}`);
      err.statusCode = response.status;
      throw err;
    }
    return response;
  }

  // Non-empty payload: encrypt and send
  const encrypted = encryptPayload(payloadString, subscription);
  const vapidHeader = `t=${token},k=${vapid.publicKey}`;

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Content-Length': String(encrypted.length),
      'Authorization': `vapid ${vapidHeader}`,
      'TTL': String(options.ttl || 86400),
      ...(options.urgency ? { 'Urgency': options.urgency } : {}),
      ...(options.topic ? { 'Topic': options.topic } : {})
    },
    body: encrypted
  });

  if (!response.ok) {
    const err = new Error(`Push failed: ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }

  return response;
}