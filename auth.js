const { createHmac, timingSafeEqual } = require('node:crypto');

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(headers, { botToken, ingestKey, ownerIds, now = Date.now() }) {
  if (equal(headers['x-ingest-key'], ingestKey)) return true;
  const raw = headers['x-telegram-init-data'];
  if (!raw || raw.length > 12000) return false;
  try {
    const params = new URLSearchParams(raw);
    const hash = params.get('hash');
    params.delete('hash');
    const date = Number(params.get('auth_date')) * 1000;
    if (!Number.isFinite(date) || date > now + 60000 || now - date > 86400000) return false;
    const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = createHmac('sha256', secret).update(check).digest('hex');
    return equal(hash, expected) && ownerIds.includes(String(JSON.parse(params.get('user')).id));
  } catch { return false; }
}

module.exports = { authorized };
