import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { handle } from '../api/dashboard.mjs';

const auth = p => ({ authorization: 'Basic ' + Buffer.from('x:' + p).toString('base64') });
const dataOf = async r => JSON.parse((await r.text()).match(/const D=(\{.*?\});\n/s)[1]);

test('with a password set, the wrong one sees nothing; without one the page is open and unnamed', async () => {
  for (const h of [{}, auth('wrong')]) assert.equal((await handle(new Request('https://vegan-weekend-lviv.vercel.app/api/dashboard', { headers: h }), { DASHBOARD_PASSWORD: 'secret' })).status, 401);
  const r = await handle(new Request('https://vegan-weekend-lviv.vercel.app/api/dashboard?fresh'), {});
  assert.equal(r.status, 200);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.ok(!(await r.text()).includes('Веган'), 'no project name on the page');
});

test('the funnel comes from GA4: visitors, begin_checkout and purchase by day', async () => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }).replace(/-/g, '');
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('oauth2')) return { json: async () => ({ access_token: 't' }) };
    const b = JSON.parse(init.body), ev = b.dimensionFilter && b.dimensionFilter.filter.stringFilter.value;
    const value = ev === 'purchase' ? '3' : ev === 'begin_checkout' ? '20' : '400';
    return { json: async () => ({ rows: [{ dimensionValues: [{ value: today }], metricValues: [{ value }] }] }) };
  };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { GA4_PROPERTY_ID: '1', GA4_SA_JSON: JSON.stringify({ client_email: 'a@b', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) };
  const d = await dataOf(await handle(new Request('https://vegan-weekend-lviv.vercel.app/api/dashboard?fresh'), env));
  const k = Object.keys(d.ga.visitors)[0];
  assert.deepEqual([d.ga.visitors[k], d.ga.clicks[k], d.ga.purchases[k]], [400, 20, 3]);
  assert.equal(d.meta, undefined, 'Meta not configured — block shows how to connect');
});

test('on the main domain there is no dashboard', async () => {
  for (const h of ['https://www.veganweekend.org/api/dashboard', 'https://veganweekend.org/api/dashboard?fresh'])
    assert.equal((await handle(new Request(h), {})).status, 404);
});

test('GA4 without a key: Vercel OIDC token → Google STS → service account token → report', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    url = String(url); calls.push(url);
    if (url.includes('sts.googleapis.com')) { const b = JSON.parse(init.body); assert.equal(b.subjectToken, 'vercel-oidc'); assert.match(b.audience, /projects\/123\/locations\/global\/workloadIdentityPools\/vercel\/providers\/vercel$/); return { json: async () => ({ access_token: 'fed' }) }; }
    if (url.includes('iamcredentials')) { assert.equal(init.headers.authorization, 'Bearer fed'); assert.match(url, /dashboard%40p\.iam\.gserviceaccount\.com:generateAccessToken$/); return { json: async () => ({ accessToken: 'sa' }) }; }
    assert.equal(init.headers.authorization, 'Bearer sa');
    return { json: async () => ({ rows: [] }) };
  };
  const r = await handle(new Request('https://vegan-weekend-lviv.vercel.app/api/dashboard?fresh', { headers: { 'x-vercel-oidc-token': 'vercel-oidc' } }),
    { GA4_PROPERTY_ID: '9', GCP_PROJECT_NUMBER: '123', GCP_SERVICE_ACCOUNT_EMAIL: 'dashboard@p.iam.gserviceaccount.com' });
  const d = JSON.parse((await r.text()).match(/const D=(\{.*?\});\n/s)[1]);
  assert.ok(d.ga && !d.ga.error, JSON.stringify(d.ga));
  assert.equal(calls.filter(u => u.includes('runReport')).length, 3);
});
