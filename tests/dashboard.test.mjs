import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../api/dashboard.mjs';

const now = Math.floor(Date.now() / 1000);
const auth = p => ({ authorization: 'Basic ' + Buffer.from('x:' + p).toString('base64') });

test('with a password set, the wrong one sees nothing; without one the page is open and unnamed', async () => {
  for (const h of [{}, auth('wrong')]) {
    const r = await handle(new Request('https://x/api/dashboard', { headers: h }), { DASHBOARD_PASSWORD: 'secret' });
    assert.equal(r.status, 401);
  }
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ reasonCode: 1100, transactionList: [] }) });
  const r = await handle(new Request('https://x/api/dashboard?fresh'), { WAYFORPAY_SECRET_KEY: 'k' });
  assert.equal(r.status, 200, 'no password configured = open (owner\'s decision)');
  assert.ok(!(await r.text()).includes('Веган'), 'no project name on the page');
});

test('only approved payments of the Lviv button are counted; tickets come from the amount', async () => {
  const tx = [
    { orderReference: 'WFP-SOC-12700913-a', transactionStatus: 'Approved', amount: 1000, processingDate: now - 60 },
    { orderReference: 'WFP-SOC-12700913-b', transactionStatus: 'Declined', amount: 500, processingDate: now - 60 },
    { orderReference: 'WFP-SOC-7189127-c', transactionStatus: 'Approved', amount: 800, processingDate: now - 60 },
    { orderReference: 'DONATE-1', transactionStatus: 'Approved', amount: 100, processingDate: now - 60 }
  ];
  globalThis.fetch = async (u, init) => { const b = JSON.parse(init.body); return { status: 200, json: async () => ({ reasonCode: 1100, transactionList: tx.filter(t => t.processingDate >= b.dateBegin && t.processingDate <= b.dateEnd) }) }; };
  const r = await handle(new Request('https://x/api/dashboard?fresh', { headers: auth('secret') }), { DASHBOARD_PASSWORD: 'secret', WAYFORPAY_SECRET_KEY: 'k' });
  assert.equal(r.status, 200);
  const html = await r.text();
  const data = JSON.parse(html.match(/const D=(\{.*?\});\n/s)[1]);
  const days = Object.values(data.wfp.sales);
  assert.equal(days.reduce((a, d) => a + d.orders, 0), 1);
  assert.equal(days.reduce((a, d) => a + d.amount, 0), 1000);
  assert.ok(days.reduce((a, d) => a + d.tickets, 0) >= 2);
  assert.deepEqual(data.wfp.buttons, { '12700913': 1, '7189127': 1 });
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
});
