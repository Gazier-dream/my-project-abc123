const crypto = require('node:crypto');
const { isIP } = require('node:net');
const TTL_MS = 1000;
const AAD = Buffer.from('market-atlas:output:v1');
const failure = (status, message) => Object.assign(new Error(message), { status });

function password() {
  const value = process.env.OUTPUT_ACCESS_PASSWORD;
  if (!value || Buffer.byteLength(value) < 32) {
    throw failure(503, 'Output access is not configured. Set OUTPUT_ACCESS_PASSWORD to a strong secret of at least 32 bytes.');
  }
  return value;
}

function bearer(req) {
  const header = req.headers?.authorization;
  return typeof header === 'string' && /^Bearer [^\s]+$/i.test(header) ? header.slice(7) : '';
}

function clientIp(req) {
  // Vercel supplies this header. Never trust forwarded headers on the local server.
  let value = process.env.VERCEL === '1'
    ? req.headers?.['x-vercel-forwarded-for']
    : req.socket?.remoteAddress;
  if (typeof value !== 'string') throw failure(403, 'Client IP unavailable.');
  value = value.trim().toLowerCase();
  if (!isIP(value)) throw failure(403, 'Client IP unavailable.');
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return value.slice(7);
  return isIP(value) === 6 ? new URL('http://[' + value + ']').hostname.slice(1, -1) : value;
}

function issueAccess(req, issuedAt) {
  const secret = password();
  const actual = crypto.createHash('sha256').update(bearer(req)).digest();
  const expected = crypto.createHash('sha256').update(secret).digest();
  if (!crypto.timingSafeEqual(actual, expected)) throw failure(401, 'A valid output access password is required.');
  const payload = { v: 1, issuedAt, ip: clientIp(req), nonce: crypto.randomBytes(16).toString('hex') };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', expected, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const val = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  return { val, issuedAt, expiresAt: issuedAt + TTL_MS, expiresInMs: TTL_MS };
}

function verifyAccess(req, now = Date.now()) {
  const key = crypto.createHash('sha256').update(password()).digest();
  const value = bearer(req);
  let payload;
  try {
    if (!/^[A-Za-z0-9_-]{40,1024}$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(bytes.subarray(12, 28));
    payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    if (payload.v !== 1 || !Number.isSafeInteger(payload.issuedAt) || !/^[a-f0-9]{32}$/.test(payload.nonce)) throw new Error();
  } catch {
    throw failure(401, 'Missing or invalid output access token.');
  }
  const age = now - payload.issuedAt;
  if (age < 0 || age > TTL_MS) throw failure(401, 'Output access token expired. Request a new token.');
  if (payload.ip !== clientIp(req)) throw failure(403, 'Output access token belongs to a different client IP.');
  return payload;
}

module.exports = { issueAccess, verifyAccess, clientIp };
