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

test('jars tab: collectors from the Notion table, sums from Monobank; JSON for the live refresh; no project name', async () => {
  const { _reset } = await import('../api/_jars.mjs'); _reset();
  const P = '413ec4da-ad6d-808f-85c8-e694f87ae7c4', C = 'coll', V = 'view';
  let mono = 0;
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.endsWith('/loadCachedPageChunkV2')) return { json: async () => ({ recordMap: {
      block: { [P]: { spaceId: 's', value: { value: { id: P, collection_id: C, view_ids: [V] } } } },
      collection: { [C]: { value: { value: { schema: { title: { name: 'Збирач', type: 'title' }, 'wVy~': { name: 'Банка', type: 'url' } } } } } } } }) };
    if (url.endsWith('/queryCollection')) return { json: async () => ({ result: { reducerResults: { collection_group_results: { blockIds: ['a', 'b', 'c'] } } }, recordMap: { block: {
      a: { value: { value: { properties: { title: [['Анчка']], 'wVy~': [['https://send.monobank.ua/jar/7Psdfu4Thz?fbclid=x']] } } } },
      b: { value: { value: { properties: { title: [['Ярик']], 'wVy~': [['https://send.monobank.ua/jar/A6qq284JRW']] } } } },
      c: { value: { value: { properties: { title: [['Ілля']] } } } } } } }) };
    if (url.includes('send.monobank.ua/api/handler')) { mono++; const id = JSON.parse(init.body).clientId; return { status: 200, json: async () => (id === '7Psdfu4Thz' ? { jarAmount: 344713, jarGoal: 321000, jarStatus: 'CLOSED' } : { jarAmount: 195400, jarGoal: 300000, jarStatus: 'ACTIVE' }) }; }
    throw new Error('unexpected ' + url);
  };
  const r = await handle(new Request('https://vegan-weekend-lviv.vercel.app/api/dashboard?jars'), {});
  const J = await r.json();
  assert.deepEqual(J.people.map(p => [p.name, p.jar, p.amount, p.goal, !!p.closed]), [['Анчка', '7Psdfu4Thz', 3447.13, 3210, true], ['Ярик', 'A6qq284JRW', 1954, 3000, false], ['Ілля', null, undefined, undefined, false]]);
  await handle(new Request('https://vegan-weekend-lviv.vercel.app/api/dashboard?jars'), {});
  assert.equal(mono, 2, 'Monobank at most once per 30 s, however many viewers');
  const page = await (await handle(new Request('https://vegan-weekend-lviv.vercel.app/api/dashboard?tab=jars'), {})).text();
  assert.match(page, /aria-current="page">Банки/);
  assert.ok(!page.includes('Веган'), 'no project name on the page');
});

test('jars: the first sums of the hour are kept, so money that came in within the hour still shows as today\'s', async () => {
  const { _reset, jars } = await import('../api/_jars.mjs'); _reset();
  let amount = 460000; const writes = [];
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.startsWith('https://r.test')) { const a = JSON.parse(init.body); if (a[0] !== 'GET' && a[0] !== 'HGETALL') writes.push(a.slice(0, 3)); return { json: async () => ({ result: a[0] === 'HGETALL' ? [] : null }) }; }
    if (url.endsWith('/loadCachedPageChunkV2')) return { json: async () => ({ recordMap: { block: { '413ec4da-ad6d-808f-85c8-e694f87ae7c4': { spaceId: 's', value: { value: { collection_id: 'c', view_ids: ['v'] } } } }, collection: { c: { value: { value: { schema: { 'wVy~': { name: 'Банка' } } } } } } } }) };
    if (url.endsWith('/queryCollection')) return { json: async () => ({ result: { reducerResults: { collection_group_results: { blockIds: ['a'] } } }, recordMap: { block: { a: { value: { value: { properties: { title: [['Данило']], 'wVy~': [['https://send.monobank.ua/jar/AWNbTfBDn4']] } } } } } } }) };
    return { status: 200, json: async () => ({ jarAmount: amount, jarGoal: 3000000, jarStatus: 'ACTIVE' }) };
  };
  const env = { UPSTASH_REDIS_REST_URL: 'https://r.test', UPSTASH_REDIS_REST_TOKEN: 't' };
  const a = await jars(env);
  amount = 790000;
  const b = await jars(env, fetch, { force: true });
  assert.equal(b.hist[b.hour + 'f'].AWNbTfBDn4, 4600, 'the first sums of the hour stay');
  assert.equal(b.hist[b.hour].AWNbTfBDn4, 7900, 'the last ones follow the jar');
  assert.equal(writes.filter(w => w[0] === 'HSETNX').length, 1);
  assert.ok(a);
});
