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

test('the funnel comes from GA4; tickets per order; refunded and excluded orders do not count', async () => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }).replace(/-/g, '');
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('oauth2')) return { json: async () => ({ access_token: 't' }) };
    const b = JSON.parse(init.body), ex = b.dimensionFilter.andGroup.expressions;
    assert.equal(ex[0].filter.fieldName, 'streamId'); assert.equal(ex[0].filter.stringFilter.value, '14373728016');
    const ev = ex[1] && ex[1].filter.stringFilter.value, dim = (b.dimensions || []).map(x => x.name);
    if (dim.includes('transactionId') && ev === 'purchase') return { json: async () => ({ rows: [['A', 2], ['B', 1], ['C', 1], ['TEST', 1], ['A', 2]].map(([id, n]) => ({ dimensionValues: [{ value: today }, { value: id }], metricValues: [{ value: String(n) }, { value: String(n * 600) }] })) }) };
    if (dim.includes('sessionDefaultChannelGroup')) return { json: async () => ({ rows: [['Paid Social', ev ? 12 : 300], ['Direct', ev ? 8 : 100]].map(([ch, n]) => ({ dimensionValues: [{ value: today }, { value: ch }], metricValues: [{ value: String(n) }] })) }) };
    if (dim.includes('transactionId') && ev === 'refund') return { json: async () => ({ rows: [{ dimensionValues: [{ value: today }, { value: 'C' }], metricValues: [{ value: '1' }] }] }) };
    const value = ev === 'begin_checkout' ? '20' : '400';
    return { json: async () => ({ rows: [{ dimensionValues: [{ value: today }], metricValues: [{ value }] }] }) };
  };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { GA4_PROPERTY_ID: '1', DASHBOARD_EXCLUDE_ORDERS: 'TEST', GA4_SA_JSON: JSON.stringify({ client_email: 'a@b', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) };
  const d = await dataOf(await handle(new Request('https://vegan-weekend-lviv.vercel.app/api/dashboard?fresh'), env));
  const k = Object.keys(d.ga.visitors)[0];
  assert.deepEqual([d.ga.visitors[k], d.ga.clicks[k], d.ga.purchases[k], d.ga.tickets[k], d.ga.refunds[k]], [400, 20, 2, 3, 1]);   // A(2)+B(1); C повернено; TEST виключено; A не двічі
  assert.deepEqual([d.ga.channels['Paid Social'].users[k], d.ga.channels['Paid Social'].clicks[k], d.ga.channels.Direct.users[k]], [300, 12, 100]);
  assert.equal(d.sales.revenue[k], 1800, 'revenue: A 1200 + B 600');
  assert.equal(d.meta, undefined, 'Meta not configured — block shows how to connect');
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
  assert.equal(calls.filter(u => u.includes('runReport')).length, 6);   // + visitors and clicks by channel
});

test('Meta: only campaigns whose name matches count (if a filter is set); the list shows all with spend; clicks, impressions, purchase value', async () => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
  globalThis.fetch = async url => ({ json: async () => ({ data: [
    { campaign_name: 'VW Lviv — tickets', date_start: today, spend: '100', impressions: '9000', inline_link_clicks: '90', actions: [{ action_type: 'purchase', value: '2' }], action_values: [{ action_type: 'purchase', value: '1200' }] },
    { campaign_name: 'Vegan Express — awareness', date_start: today, spend: '300', actions: [{ action_type: 'purchase', value: '5' }] },
    { campaign_name: 'Львів ретаргет', date_start: today, spend: '50' }
  ] }) });
  const env = { META_AD_ACCOUNT_ID: '1', META_ADS_TOKEN: 't', META_CAMPAIGN_MATCH: 'lviv, Львів' };
  const d = JSON.parse((await (await handle(new Request('https://vegan-weekend-lviv.vercel.app/api/dashboard?fresh'), env)).text()).match(/const D=(\{.*?\});\n/s)[1]);
  assert.equal(d.meta.spend[today], 150); assert.equal(d.meta.purchases[today], 2);
  assert.equal(d.meta.value[today], 1200); assert.equal(d.meta.impressions[today], 9000); assert.equal(d.meta.clicks[today], 90);
  assert.deepEqual(d.meta.campaigns.map(c => [c.name, c.used]), [['Vegan Express — awareness', false], ['VW Lviv — tickets', true], ['Львів ретаргет', true]]);
});

test('on the main domain there is no dashboard', async () => {
  for (const h of ['https://www.veganweekend.org/api/dashboard', 'https://veganweekend.org/api/dashboard?fresh'])
    assert.equal((await handle(new Request(h), {})).status, 404);
});

test('Meta: without a filter the whole account counts', async () => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
  globalThis.fetch = async url => ({ json: async () => ({ data: [
    { campaign_name: 'A', date_start: today, spend: '100', actions: [{ action_type: 'landing_page_view', value: '40' }, { action_type: 'purchase', value: '1' }] },
    { campaign_name: 'B', date_start: today, spend: '50' }
  ] }) });
  const d = JSON.parse((await (await handle(new Request('https://vegan-weekend-lviv.vercel.app/api/dashboard?fresh'), { META_AD_ACCOUNT_ID: '159631582954289', META_ADS_TOKEN: 't' })).text()).match(/const D=(\{.*?\});\n/s)[1]);
  assert.equal(d.meta.spend[today], 150); assert.equal(d.meta.views[today], 40); assert.equal(d.meta.filtered, false);
  assert.ok(d.meta.campaigns.every(c => c.used));
});

test('Meta: an account in dollars — spend and purchase value turn into hryvnias at the NBU rate', async () => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
  globalThis.fetch = async url => {
    url = String(url);
    if (url.includes('bank.gov.ua')) { assert.match(url, /valcode=USD/); return { json: async () => ([{ cc: 'USD', rate: 41.5 }]) }; }
    if (url.includes('fields=currency')) return { json: async () => ({ currency: 'USD', id: 'act_1' }) };
    return { json: async () => ({ data: [{ campaign_name: 'A', date_start: today, spend: '10', actions: [{ action_type: 'purchase', value: '1' }], action_values: [{ action_type: 'purchase', value: '14.5' }] }] }) };
  };
  const d = await dataOf(await handle(new Request('https://vegan-weekend-lviv.vercel.app/api/dashboard?fresh'), { META_AD_ACCOUNT_ID: '1', META_ADS_TOKEN: 't' }));
  assert.equal(d.meta.currency, 'USD'); assert.equal(d.meta.rate, 41.5);
  assert.equal(d.meta.spend[today], 415); assert.equal(Math.round(d.meta.value[today] * 100) / 100, 601.75);
  assert.equal(d.meta.campaigns[0].spend, 415);
});
