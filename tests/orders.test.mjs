import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handle as webhook } from '../api/wayforpay.mjs';
import { handle as dashboard } from '../api/dashboard.mjs';

/* in-memory stand-in for the Upstash REST API */
function fakeRedis() {
  const h = {};
  const f = async (url, init) => {
    url = String(url);
    if (url.startsWith('https://redis.test')) {
      const [c, , field, value] = JSON.parse(init.body);
      if (c === 'HSET') { h[field] = value; return { json: async () => ({ result: 1 }) }; }
      if (c === 'HGET') return { json: async () => ({ result: h[field] ?? null }) };
      if (c === 'HGETALL') return { json: async () => ({ result: Object.entries(h).flat() }) };
    }
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };   // Meta / GA
  };
  f.h = h; return f;
}
const SECRET = 's', env = { WAYFORPAY_SECRET_KEY: SECRET, META_CAPI_TOKEN: 'm', UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'r' };
const now = Math.floor(Date.now() / 1000);
function pay(ref, status = 'Approved', count = 2) {
  const p = { merchantAccount: 'everyanimal_org', orderReference: ref, amount: 500 * count, currency: 'UAH', authCode: '1', cardPan: '4****1', transactionStatus: status, reasonCode: 1100, processingDate: now, email: 'a@b.c', phone: '380', clientName: 'Імʼя Прізвище', products: [{ name: 'Квиток', price: 500, count }] };
  p.merchantSignature = createHmac('md5', SECRET).update([p.merchantAccount, p.orderReference, p.amount, p.currency, p.authCode, p.cardPan, p.transactionStatus, p.reasonCode].join(';')).digest('hex');
  return new Request('https://x/api/wayforpay', { method: 'POST', body: JSON.stringify(p) });
}

test('every paid ticket order is stored at once — tickets, sum, time, no personal data; a refund marks it', async () => {
  const f = fakeRedis();
  await webhook(pay('WFP-SOC-12700913-a'), env, f);
  const rec = JSON.parse(f.h['WFP-SOC-12700913-a']);
  assert.deepEqual([rec.tickets, rec.amount, rec.status, rec.t], [2, 1000, 'paid', now]);
  assert.ok(!JSON.stringify(f.h).match(/a@b\.c|380|Прізвище/), 'no e-mail, phone or name in the store');
  await webhook(pay('WFP-SOC-12700913-a', 'Refunded'), env, f);
  assert.equal(JSON.parse(f.h['WFP-SOC-12700913-a']).status, 'refunded');
});

test('the dashboard counts orders from the store instantly; refunded and excluded ones do not count', async () => {
  const f = fakeRedis();
  await webhook(pay('WFP-SOC-12700913-a', 'Approved', 2), env, f);
  await webhook(pay('WFP-SOC-12700913-b', 'Approved', 1), env, f);
  await webhook(pay('WFP-SOC-12700913-c', 'Approved', 1), env, f);
  await webhook(pay('WFP-SOC-12700913-c', 'Refunded', 1), env, f);
  await webhook(pay('WFP-SOC-12700913-test', 'Approved', 3), env, f);
  globalThis.fetch = f;
  const r = await dashboard(new Request('https://vegan-weekend-lviv.vercel.app/api/dashboard?fresh'), { UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'r', DASHBOARD_EXCLUDE_ORDERS: 'WFP-SOC-12700913-test' });
  const d = JSON.parse((await r.text()).match(/const D=(\{.*?\});\n/s)[1]);
  const sum = o => Object.values(o).reduce((a, x) => a + x, 0);
  assert.deepEqual([sum(d.sales.purchases), sum(d.sales.tickets), sum(d.sales.refunds), d.sales.source], [2, 3, 1, 'db']);
});
