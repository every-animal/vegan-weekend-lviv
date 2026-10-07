import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { handle, parseBody, validSignature, metaEvent } from '../api/wayforpay.mjs';

const SECRET = 'test-secret';
const md5 = s => createHmac('md5', SECRET).update(s).digest('hex');
const sha = s => createHash('sha256').update(s).digest('hex');
const now = Math.floor(Date.now() / 1000);

/* the shape WayForPay sends (see the Make sample), with made-up buyer data */
function payment(over = {}) {
  const p = {
    merchantAccount: 'everyanimal_org', orderReference: 'WFP-SOC-7189127-test0001', amount: 1200, currency: 'UAH',
    authCode: '123456', email: ' Test.Buyer@Example.com ', phone: '+380 50 000 00 00', createdDate: now - 5, processingDate: now - 2,
    cardPan: '41****1111', cardType: 'Visa', transactionStatus: 'Approved', reason: 'Ok', reasonCode: 1100,
    clientName: 'Тест «Лапки» Покупець', products: [{ name: 'Квиток / ticket "Львів"', price: 600, count: 2 }], ...over
  };
  p.merchantSignature = md5([p.merchantAccount, p.orderReference, p.amount, p.currency, p.authCode, p.cardPan, p.transactionStatus, p.reasonCode].join(';'));
  return p;
}
const env = { WAYFORPAY_SECRET_KEY: SECRET, META_CAPI_TOKEN: 'meta-token' };
const req = body => new Request('https://www.veganweekend.org/api/wayforpay', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
function fakeFetch(status = 200) { const calls = []; const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: status < 400, status, text: async () => '{}' }; }; f.calls = calls; return f; }

test('a paid ticket goes to Meta once, as Purchase, and WayForPay gets a signed accept', async () => {
  const f = fakeFetch(); const p = payment();
  const r = await handle(req(JSON.stringify(p)), env, f);
  assert.equal(r.status, 200);
  const a = await r.json();
  assert.equal(a.status, 'accept'); assert.equal(a.orderReference, p.orderReference);
  assert.equal(a.signature, md5(`${p.orderReference};accept;${a.time}`));
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /graph\.facebook\.com\/v21\.0\/1647718446547735\/events\?access_token=meta-token$/);
  const e = f.calls[0].body.data[0];
  assert.equal(e.event_name, 'Purchase'); assert.equal(e.event_id, p.orderReference); assert.equal(e.event_time, p.processingDate);
  assert.deepEqual(e.user_data.em, [sha('test.buyer@example.com')]);
  assert.deepEqual(e.user_data.ph, [sha('380500000000')]);
  assert.equal(e.custom_data.value, 1200); assert.equal(e.custom_data.currency, 'UAH'); assert.equal(e.custom_data.num_items, 2);
  assert.ok(!JSON.stringify(f.calls[0].body).includes('Example.com'), 'no plain e-mail leaves the server');
});

test('names with quotes and slashes (what broke Make) are read fine', () => {
  const p = payment();
  assert.deepEqual(parseBody(JSON.stringify(p)), p);
  assert.deepEqual(parseBody(encodeURIComponent(JSON.stringify(p))), p);
  assert.deepEqual(parseBody(new URLSearchParams({ [JSON.stringify(p)]: '' }).toString()), p);
});

test('a forged signature is refused and nothing is sent', async () => {
  const f = fakeFetch(); const p = { ...payment(), amount: 999999 };
  const r = await handle(req(JSON.stringify(p)), env, f);
  assert.equal(r.status, 403); assert.equal(f.calls.length, 0);
});

test('declined payments and other orders are accepted but not sent to Meta', async () => {
  for (const over of [{ transactionStatus: 'Declined', reasonCode: 1101 }, { orderReference: 'DONATE-42' }]) {
    const f = fakeFetch(); const r = await handle(req(JSON.stringify(payment(over))), env, f);
    assert.equal(r.status, 200); assert.equal((await r.json()).status, 'accept'); assert.equal(f.calls.length, 0);
  }
});

test('if Meta fails, WayForPay is not told «accept» — it will retry', async () => {
  const r = await handle(req(JSON.stringify(payment())), env, fakeFetch(500));
  assert.equal(r.status, 502);
});

test('GA4 purchase goes too when its api secret is set', async () => {
  const f = fakeFetch(); await handle(req(JSON.stringify(payment())), { ...env, GA4_API_SECRET: 'ga' }, f);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].url, /measurement_id=G-4PKFB5CKBV&api_secret=ga/);
  assert.equal(f.calls[1].body.events[0].params.transaction_id, payment().orderReference);
});

test('without secrets configured it refuses instead of accepting blindly', async () => {
  const r = await handle(req(JSON.stringify(payment())), {}, fakeFetch());
  assert.equal(r.status, 500);
});

test('an old payment (retried days later) is sent with the time of sending', () => {
  const e = metaEvent(payment({ processingDate: now - 10 * 86400 }));
  assert.ok(Math.abs(e.event_time - now) < 5);
});

test('signature check is exact', () => {
  const p = payment();
  assert.equal(validSignature(p, SECRET), true);
  assert.equal(validSignature({ ...p, merchantSignature: 'x' }, SECRET), false);
  assert.equal(validSignature(p, 'other'), false);
});

test('a refund goes to GA4 as refund (same transaction), nothing to Meta, and is accepted', async () => {
  const f = fakeFetch(); const r = await handle(req(JSON.stringify(payment({ transactionStatus: 'Refunded', reasonCode: 1100 }))), { ...env, GA4_API_SECRET: 'ga' }, f);
  assert.equal(r.status, 200); assert.equal((await r.json()).status, 'accept');
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /google-analytics/);
  assert.equal(f.calls[0].body.events[0].name, 'refund'); assert.equal(f.calls[0].body.events[0].params.transaction_id, payment().orderReference);
});
