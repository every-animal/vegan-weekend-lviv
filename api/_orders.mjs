/* Сховище оплат (рішення власника 07.10.2026): Upstash Redis через Vercel Marketplace, REST API без бібліотек.
   Один хеш `vw:orders`: номер замовлення → {t, tickets, amount, status}. Жодних особистих даних (email, телефон, імʼя).
   Змінні: UPSTASH_REDIS_REST_URL / _TOKEN або KV_REST_API_URL / _TOKEN (Vercel додає їх сам при підключенні бази). */
const KEY = 'vw:orders';

export function store(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL, token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

async function cmd(s, args, fetchImpl = fetch) {
  const r = await fetchImpl(s.url, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const j = await r.json();
  if (j.error) throw new Error(`Redis: ${j.error}`);
  return j.result;
}

export const ticketsOf = p => {
  const products = Array.isArray(p.products) ? p.products : [];
  return Math.max(1, products.reduce((a, x) => a + (Number(x.count) || 1), 0));
};

/* оплата: записати; повернення: позначити (і якщо замовлення ще не було — записати як повернене) */
export async function saveOrder(p, status, env = process.env, fetchImpl = fetch) {
  const s = store(env); if (!s) return false;
  const prev = await cmd(s, ['HGET', KEY, p.orderReference], fetchImpl).catch(() => null);
  const old = prev ? JSON.parse(prev) : null;
  const rec = {
    t: (old && old.t) || Number(p.processingDate) || Number(p.createdDate) || Math.floor(Date.now() / 1000),
    tickets: (old && old.tickets) || ticketsOf(p),
    amount: (old && old.amount) || Number(p.amount) || 0,
    status: status === 'refunded' || (old && old.status === 'refunded') ? 'refunded' : 'paid',
    ...(status === 'refunded' ? { rt: Math.floor(Date.now() / 1000) } : {})
  };
  await cmd(s, ['HSET', KEY, p.orderReference, JSON.stringify(rec)], fetchImpl);
  return true;
}

export async function allOrders(env = process.env, fetchImpl = fetch) {
  const s = store(env); if (!s) return null;
  const flat = await cmd(s, ['HGETALL', KEY], fetchImpl) || [];
  const out = {}; for (let i = 0; i < flat.length; i += 2) out[flat[i]] = JSON.parse(flat[i + 1]); return out;
}
