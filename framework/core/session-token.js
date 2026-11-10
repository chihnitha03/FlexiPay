// Short-lived customer session tokens. The merchant backend (which already authenticated its
// user) signs { merchant, customer, exp } with its widget secret; the FlexPrice widget passes it
// back so FlexPrice can trust the customer reference without seeing credentials or PII.

import crypto from 'node:crypto';

const b64u = (s) => Buffer.from(s).toString('base64url');

export function signSession({ merchantId, customerRef, ttlSeconds = 3600 }, secret) {
  const payload = b64u(JSON.stringify({ m: merchantId, c: customerRef, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token, secret, merchantId) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.m !== merchantId || data.exp < Date.now() / 1000) return null;
    return { merchantId: data.m, customerRef: data.c };
  } catch {
    return null;
  }
}
