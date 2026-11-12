/* Дашборд-воронка (рішення власника 06.10.2026): https://vegan-weekend-lviv.vercel.app/api/dashboard — лише на домені Vercel
   (на veganweekend.org — 404), відкритий, без назви проєкту, noindex.
   Відповідає на три питання: скільки людей прийшло на сайт і скільки з них натиснули «Купити»; скільки реально купило;
   скільки коштує проданий квиток з реклами Meta.

   Усі три кроки воронки — з Google Analytics 4: відвідувачі, begin_checkout (клік «Купити», браузер),
   purchase (оплата — шле сервер з вебхука WayForPay, api/wayforpay.mjs). Одне джерело — цифри узгоджені між собою.
   (API WayForPay TRANSACTION_LIST / CHECK_STATUS відповідають «Invalid signature» тим самим ключем, яким успішно
   перевіряються вебхуки, — тому оплати тут не з WayForPay.)

   Змінні середовища (Vercel, Production):
   GA4_PROPERTY_ID                    — числовий ID ресурсу GA
   доступ до GA — без ключа (Workload Identity Federation: Google довіряє OIDC-посвідченню Vercel; ключі в організації
   kozhnatvaryna.org заборонені політикою):
   GCP_PROJECT_NUMBER, GCP_SERVICE_ACCOUNT_EMAIL — номер проєкту Google Cloud і службовий акаунт (роль Viewer у GA);
   пул і провайдер — `vercel` / `vercel` (GCP_WIF_POOL, GCP_WIF_PROVIDER, якщо інші)
   або, як запасний шлях, GA4_SA_JSON — JSON ключа службового акаунта
   META_AD_ACCOUNT_ID, META_ADS_TOKEN — рекламний кабінет (act_…) і токен з правом ads_read
                                        (з 08.11.2026 — окремий кабінет Веган Вікенду 159631582954289, рахується весь)
   DASHBOARD_EXCLUDE_ORDERS           — номери замовлень WayForPay через кому, які не рахувати (тестові, повернені до 07.10.2026)
   META_CAMPAIGN_MATCH                — слова в назвах кампаній Веган Вікенду (через кому); без нього — усі кампанії кабінету
   DASHBOARD_PASSWORD                 — необовʼязково: якщо задати, сторінка питатиме пароль (логін будь-який) */
import { createSign, timingSafeEqual } from 'node:crypto';
import { allOrders } from './_orders.mjs';
import { jars } from './_jars.mjs';

const DAY = 86400;
const kyivDate = ts => new Date(Number(ts) * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }); // YYYY-MM-DD за Києвом
const days = (from, to) => { const out = []; for (let t = Date.parse(from); t <= Date.parse(to); t += DAY * 1000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };

/* ---------- Google Analytics Data API (службовий акаунт, JWT без бібліотек) ---------- */
/* доступ до Google: без ключа — OIDC-посвідчення Vercel → STS → токен службового акаунта; або ключ JSON (запасний шлях) */
async function googleToken(env, oidc) {
  const scope = 'https://www.googleapis.com/auth/analytics.readonly';
  if (env.GA4_SA_JSON) {
    const sa = JSON.parse(env.GA4_SA_JSON), now = Math.floor(Date.now() / 1000);
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')}`;
    const tok = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) })).json();
    if (!tok.access_token) throw new Error(`Google: ${tok.error_description || tok.error || 'немає доступу'}`);
    return tok.access_token;
  }
  if (!oidc) throw new Error('Google: немає OIDC-посвідчення Vercel (працює лише на розгорнутому сайті)');
  const audience = `//iam.googleapis.com/projects/${env.GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${env.GCP_WIF_POOL || 'vercel'}/providers/${env.GCP_WIF_PROVIDER || 'vercel'}`;
  const sts = await (await fetch('https://sts.googleapis.com/v1/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    grantType: 'urn:ietf:params:oauth:grant-type:token-exchange', audience, scope: 'https://www.googleapis.com/auth/cloud-platform',
    requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token', subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt', subjectToken: oidc }) })).json();
  if (!sts.access_token) throw new Error(`Google STS: ${sts.error_description || sts.error || JSON.stringify(sts).slice(0, 200)}`);
  const sa = await (await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(env.GCP_SERVICE_ACCOUNT_EMAIL)}:generateAccessToken`, { method: 'POST',
    headers: { authorization: `Bearer ${sts.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ scope: [scope] }) })).json();
  if (!sa.accessToken) throw new Error(`Google: ${(sa.error && sa.error.message) || 'не вдалося діяти від імені службового акаунта'}`);
  return sa.accessToken;
}

/* ---------- Google Analytics Data API ----------
   У ресурсі «Кожна тварина» два потоки (veganexpress.org і Vegan Weekend) — рахуємо лише потік Vegan Weekend */
const GA4_STREAM = '14373728016';
async function ga4(propertyId, accessToken, from, stream = GA4_STREAM, exclude = []) {
  const tok = { access_token: accessToken };
  const byStream = { filter: { fieldName: 'streamId', stringFilter: { value: stream } } };
  const withStream = f => ({ andGroup: { expressions: [byStream, ...(f ? [f] : [])] } });
  const run = async body => {
    const r = await (await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ dateRanges: [{ startDate: from, endDate: 'today' }], dimensions: [{ name: 'date' }], limit: 400, ...body }) })).json();
    if (r.error) throw new Error(`Google: ${r.error.message}`);
    const out = {}; for (const row of r.rows || []) { const d = row.dimensionValues[0].value; out[`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`] = Number(row.metricValues[0].value); } return out;
  };
  const event = name => ({ metrics: [{ name: 'eventCount' }], dimensionFilter: withStream({ filter: { fieldName: 'eventName', stringFilter: { value: name } } }) });
  /* оплати — по кожному замовленню: квитки (кількість у замовленні) і чи було повернення.
     Повернене замовлення (подія refund) і замовлення зі списку exclude не рахуються — ні як оплата, ні їхні квитки. */
  const rows = async body => {
    const r = await (await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ dateRanges: [{ startDate: from, endDate: 'today' }], limit: 10000, ...body }) })).json();
    if (r.error) throw new Error(`Google: ${r.error.message}`);
    return (r.rows || []).map(x => [...x.dimensionValues.map(v => v.value), ...x.metricValues.map(v => Number(v.value))]);
  };
  const iso = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
  const [visitors, clicks, bought, refundRows, chUsers, chClicks] = await Promise.all([
    run({ metrics: [{ name: 'totalUsers' }], dimensionFilter: withStream() }),
    run(event('begin_checkout')),
    rows({ dimensions: [{ name: 'date' }, { name: 'transactionId' }], metrics: [{ name: 'itemsPurchased' }, { name: 'purchaseRevenue' }], dimensionFilter: withStream({ filter: { fieldName: 'eventName', stringFilter: { value: 'purchase' } } }) }),
    rows({ dimensions: [{ name: 'date' }, { name: 'transactionId' }], metrics: [{ name: 'eventCount' }], dimensionFilter: withStream({ filter: { fieldName: 'eventName', stringFilter: { value: 'refund' } } }) }),
    /* звідки прийшли відвідувачі й ті, хто натиснув «Купити»: групи каналів GA (реклама в соцмережах, соцмережі, пошук, прямі…) */
    rows({ dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'totalUsers' }], dimensionFilter: withStream() }),
    rows({ dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'eventCount' }], dimensionFilter: withStream({ filter: { fieldName: 'eventName', stringFilter: { value: 'begin_checkout' } } }) })
  ]);
  const channels = {};
  const put = (rs, key) => { for (const [d, ch, n] of rs) { const c = channels[ch] || (channels[ch] = { users: {}, clicks: {} }); c[key][iso(d)] = (c[key][iso(d)] || 0) + n; } };
  put(chUsers, 'users'); put(chClicks, 'clicks');
  const refunded = new Set(refundRows.map(r => r[1]).concat(exclude || []));
  const purchases = {}, tickets = {}, refunds = {}, seen = new Set();
  for (const [d, id, items] of bought) {
    if (!id || id === '(not set)' || seen.has(id) || refunded.has(id)) continue;
    seen.add(id); const k = iso(d);
    purchases[k] = (purchases[k] || 0) + 1; tickets[k] = (tickets[k] || 0) + Math.max(1, items);
  }
  const rseen = new Set();
  for (const [d, id] of refundRows) { if (!id || rseen.has(id)) continue; rseen.add(id); const k = iso(d); refunds[k] = (refunds[k] || 0) + 1; }
  const orders = {}; for (const [d, id, items, value] of bought) if (id && id !== '(not set)' && !orders[id]) orders[id] = { day: iso(d), tickets: Math.max(1, items), amount: value || 0 };
  const refundedDays = {}; for (const [d, id] of refundRows) if (id && !refundedDays[id]) refundedDays[id] = iso(d);
  return { visitors, clicks, purchases, tickets, refunds, excluded: (exclude || []).length, orders, refundedDays, channels };
}

/* ---------- Meta Marketing API: що зробила реклама ----------
   З 08.11.2026 у Веган Вікенду окремий кабінет — рахується весь. META_CAMPAIGN_MATCH (слова в назвах кампаній через кому)
   лишився на випадок спільного кабінету: якщо заданий — рахуються лише кампанії з цими словами.
   По днях: витрати, покази, кліки на посилання, перегляди сторінки після кліку, початки оформлення, покупки й їхня сума,
   які Meta приписує рекламі (клік до 7 днів або перегляд до 1 дня перед покупкою — налаштування кабінету за замовчуванням).
   Гроші: кабінет може рахувати не в гривнях (кабінет ВВ — у доларах). Тоді витрати й суму покупок переводимо в гривні
   за сьогоднішнім курсом НБУ, щоб їх можна було порівняти з виручкою; суму у валюті кабінету теж віддаємо. */
const pick = (list, types) => { for (const t of types) { const a = (list || []).find(x => x.action_type === t); if (a) return Number(a.value) || 0; } return 0; };
async function meta(account, token, from, to, match) {
  const id = String(account).startsWith('act_') ? account : `act_${account}`;
  const words = String(match || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
  let u = `https://graph.facebook.com/v21.0/${id}/insights?level=campaign&fields=campaign_name,spend,impressions,inline_link_clicks,actions,action_values&time_increment=1&limit=500&time_range=${encodeURIComponent(JSON.stringify({ since: from, until: to }))}&access_token=${encodeURIComponent(token)}`;
  const k = ['spend', 'impressions', 'clicks', 'views', 'checkouts', 'purchases', 'value'];
  const day = Object.fromEntries(k.map(x => [x, {}])), campaigns = {};
  const add = (key, d, n) => { if (n) day[key][d] = (day[key][d] || 0) + n; };
  const PURCHASE = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'];
  const acc = await (await fetch(`https://graph.facebook.com/v21.0/${id}?fields=currency&access_token=${encodeURIComponent(token)}`)).json();
  if (acc.error) throw new Error(`Meta: ${acc.error.message}`);
  const currency = String(acc.currency || 'UAH').toUpperCase();
  let rate = 1;
  if (currency !== 'UAH') {
    const r = await (await fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=${encodeURIComponent(currency)}&json`)).json();
    rate = Number(r && r[0] && r[0].rate);
    if (!(rate > 0)) throw new Error(`Meta: кабінет рахує в ${currency}, а курс НБУ зараз недоступний`);
  }
  const raw = { spend: 0, value: 0 };
  for (let page = 0; u && page < 20; page++) {
    const j = await (await fetch(u)).json();
    if (j.error) throw new Error(`Meta: ${j.error.message}`);
    for (const row of j.data || []) {
      const name = row.campaign_name || '—', sp0 = Number(row.spend) || 0, sp = sp0 * rate, d = row.date_start;
      const used = !words.length || words.some(w => name.toLowerCase().includes(w));
      const c = campaigns[name] || (campaigns[name] = { spend: 0, purchases: 0, clicks: 0, used });
      const pu = pick(row.actions, PURCHASE), cl = Number(row.inline_link_clicks) || 0;
      c.spend += sp; c.purchases += pu; c.clicks += cl;
      if (!used) continue;
      add('spend', d, sp); add('impressions', d, Number(row.impressions) || 0); add('clicks', d, cl);
      add('views', d, pick(row.actions, ['landing_page_view', 'omni_landing_page_view']));
      add('checkouts', d, pick(row.actions, ['initiate_checkout', 'omni_initiated_checkout', 'offsite_conversion.fb_pixel_initiate_checkout']));
      const val0 = pick(row.action_values, PURCHASE);
      raw.spend += sp0; raw.value += val0;
      add('purchases', d, pu); add('value', d, val0 * rate);
    }
    u = j.paging && j.paging.next;
  }
  return { ...day, filtered: words.length > 0, match: words, account: id.slice(4), currency, rate,
    campaigns: Object.entries(campaigns).map(([name, c]) => ({ name, spend: Math.round(c.spend), purchases: c.purchases, clicks: c.clicks, used: c.used })).sort((a, b) => b.spend - a.spend) };
}

/* ---------- сторінка: темна, тонкі лінії, великі цифри шрифтом Heading Now, рожевий — акцент ---------- */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const head = (title, refresh) => `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
${refresh}<meta name="theme-color" content="#1c1b1b"><title>${title}</title>
<link rel="preload" href="/assets/fonts/HeadingNowVar.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/HeadingNowVarItalic.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:"HN";src:url(/assets/fonts/HeadingNowVar.woff2) format("woff2");font-weight:100 1000;font-style:normal}
@font-face{font-family:"HN";src:url(/assets/fonts/HeadingNowVarItalic.woff2) format("woff2");font-weight:100 1000;font-style:italic}
:root{--bg:#1c1b1b;--card:#6d6d6d;--card-2:#2a2828;--pink:#fe75be;--ink:#fff;--ink-2:#d9d6d3;--ink-3:#a19c97;--on-pink:#2b2b2b;--rule:rgba(255,255,255,.12)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:18px 16px 56px}
.hn{font-family:"HN",system-ui,sans-serif;text-transform:uppercase;line-height:.86}
.cap{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)}
/* top */
.top{display:flex;justify-content:space-between;align-items:center;gap:12px}
.live{display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-2)}
.live i{width:8px;height:8px;border-radius:50%;background:var(--pink);animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(254,117,190,.6)}70%{box-shadow:0 0 0 8px rgba(254,117,190,0)}100%{box-shadow:0 0 0 0 rgba(254,117,190,0)}}
.count{font-size:13px;color:var(--ink-2)}.count b{font-family:"HN";font-size:22px;font-variation-settings:"wght" 800,"wdth" 400;color:var(--pink);vertical-align:-2px}
/* period */
.per{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0 14px;background:var(--card-2);padding:4px;border-radius:999px;width:max-content}
.per button{all:unset;cursor:pointer;padding:8px 14px;border-radius:999px;font-size:13px;color:var(--ink-2)}
.per button[aria-pressed=true]{background:var(--pink);color:var(--on-pink);font-weight:600}
.per button:focus-visible{outline:2px solid var(--pink);outline-offset:2px}
/* hero */
.hero{background:var(--pink);color:var(--on-pink);border-radius:22px;padding:20px 22px 22px;rotate:-1.2deg;margin:6px 4px 0}
.hero .cap{color:rgba(43,43,43,.75)}
.hero .big{font-size:clamp(110px,32vw,190px);font-variation-settings:"wght" 900,"wdth" 520;margin-top:6px}
.hero .row{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin-top:10px;font-size:14px}
.chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 11px;font-size:13px;font-weight:600;background:rgba(43,43,43,.12)}
.chip.up{background:#2b2b2b;color:var(--pink)}
/* sections */
h2{font-family:"HN";text-transform:uppercase;font-size:30px;font-variation-settings:"wght" 800,"wdth" 600;margin:40px 0 14px;line-height:.9}
h2 i{font-style:italic;color:var(--pink);font-variation-settings:"wght" 900,"wdth" 300}
/* funnel */
.fun{display:flex;flex-direction:column;align-items:center;gap:0}
.stage{width:var(--w);min-width:200px;max-width:100%;border-radius:16px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px;transform-origin:50% 0}
.stage .l{font-size:13px;line-height:1.25}.stage .n{font-size:46px;font-variation-settings:"wght" 800,"wdth" 520}
.s1{background:var(--card)}.s2{background:#a46a8b}.s3{background:var(--pink);color:var(--on-pink)}
.step{display:flex;align-items:center;gap:8px;padding:8px 0;color:var(--ink-2);font-size:13px}
.step b{font-family:"HN";font-size:24px;font-variation-settings:"wght" 800,"wdth" 500;color:var(--pink)}
.step{flex-wrap:wrap;justify-content:center;text-align:center}.step .why{flex-basis:100%;font-size:12px;color:var(--ink-3)}
.step:before{content:"";width:2px;height:22px;background:var(--rule)}
.total{margin-top:14px;text-align:center;color:var(--ink-2);font-size:14px}.total b{color:var(--pink)}
/* ads */
.ad{background:var(--card-2);border-radius:20px;padding:20px 20px 18px}
.ad .say{font-size:15px;color:var(--ink-2)}.ad .say b{display:block;font-family:"HN";font-size:clamp(60px,15vw,96px);font-variation-settings:"wght" 900,"wdth" 520;color:var(--pink);line-height:.9;margin:6px 0 4px;text-transform:uppercase}
.trio{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px}
.trio div{background:var(--bg);border-radius:14px;padding:12px}.trio .v{font-family:"HN";font-size:30px;font-variation-settings:"wght" 800,"wdth" 520;margin-top:4px}.trio small{display:block;color:var(--ink-3);font-size:11px;margin-top:4px;line-height:1.3}
.camps{margin-top:14px;background:none;padding:0;border-radius:0}.camps summary{font-family:inherit;text-transform:none;font-size:13px;color:var(--ink-2);padding:8px 0}.camps summary:after{content:''}.camp{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--rule);font-size:13px}.camp b{font-weight:600;white-space:nowrap}.camp.off{color:var(--ink-3);text-decoration:line-through}
.todo{background:var(--card-2);border-radius:20px;padding:18px 20px;color:var(--ink-2)}
/* total + ads grid + sources */
.sub{color:var(--ink-3);font-size:13px;margin:-6px 0 14px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.ad .grid{grid-template-columns:repeat(3,1fr)}
.grid>div{background:var(--card-2);border-radius:14px;padding:12px 12px 11px}.grid .v{font-family:"HN";font-size:30px;font-variation-settings:"wght" 800,"wdth" 520;margin-top:4px;white-space:nowrap}.grid small{display:block;color:var(--ink-3);font-size:11px;margin-top:4px;line-height:1.3}
.grid>.hl,.ad .grid>.hl{background:var(--pink);color:var(--on-pink)}.grid .hl .cap,.grid .hl small{color:rgba(43,43,43,.75)}
.ad .grid>div{background:var(--bg)}
.mf{display:flex;flex-direction:column;gap:6px;margin-top:16px}
.mf div{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:baseline;padding:8px 12px;border-radius:10px;background:linear-gradient(90deg,rgba(254,117,190,.28) var(--w),var(--bg) var(--w));font-size:13px}
.mf b{font-family:"HN";font-size:22px;font-variation-settings:"wght" 800,"wdth" 520}.mf span:last-child{color:var(--ink-3);font-size:12px;min-width:3.5em;text-align:right}
.src{margin-top:14px;background:var(--card-2);border-radius:20px;padding:6px 16px}
.src .r{display:grid;grid-template-columns:minmax(0,1fr) 64px 64px 52px;gap:8px;align-items:baseline;padding:9px 0;border-top:1px solid var(--rule);font-size:13px}
.src .r:first-child{border-top:0;color:var(--ink-3);font-size:10px;letter-spacing:.04em;text-transform:uppercase;line-height:1.2}
.src .r b{font-family:"HN";font-size:20px;font-variation-settings:"wght" 800,"wdth" 520;text-align:right}.src .r span:not(:first-child){text-align:right}
.src .r.ad b:first-of-type{color:var(--pink)}
.note{margin-top:10px;font-size:12px;color:var(--ink-3)}
.todo b{color:var(--ink)}
/* days */
.chart{position:relative;background:var(--card-2);border-radius:20px;padding:18px 14px 10px}
.bars{display:flex;align-items:flex-end;gap:3px;height:150px}
.bars button{all:unset;flex:1;height:100%;display:flex;align-items:flex-end;cursor:pointer;position:relative}
.bars .b{width:100%;background:var(--pink);border-radius:4px 4px 0 0;min-height:2px;transform-origin:bottom}
.bars .b.zero{background:var(--rule)}
.bars button:hover .b,.bars button:focus-visible .b,.bars button[aria-current=true] .b{background:#fff}
.bars .best{position:absolute;bottom:calc(var(--h) + 6px);left:50%;translate:-50% 0;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--pink);white-space:nowrap}
.axis{display:flex;justify-content:space-between;color:var(--ink-3);font-size:11px;margin-top:8px}
.read{margin-top:12px;min-height:44px;border-top:1px solid var(--rule);padding-top:10px;display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:var(--ink-2)}
.read b{font-family:"HN";font-size:22px;font-variation-settings:"wght" 800,"wdth" 520;color:var(--ink)}
.read .d{color:var(--pink)}
.err{color:#ff9b9b;font-size:13px;margin-top:8px}
/* how */
details{margin-top:36px;background:var(--card-2);border-radius:20px;padding:4px 18px}
summary{cursor:pointer;padding:14px 0;font-family:"HN";text-transform:uppercase;font-size:20px;font-variation-settings:"wght" 800,"wdth" 600;list-style:none}
summary::-webkit-details-marker{display:none}summary:after{content:" +";color:var(--pink)}details[open] summary:after{content:" –"}
.how dt{font-weight:600;margin-top:14px}.how dd{margin:4px 0 0;color:var(--ink-2);font-size:14px;line-height:1.55;padding-bottom:14px;border-bottom:1px solid var(--rule)}.how dd:last-child{border:0}
.how code{color:var(--pink);font-size:12px}
.foot{margin-top:18px;color:var(--ink-3);font-size:12px;text-align:center}
/* motion: blocks spring in like the site; numbers count up */
@keyframes pop{0%{opacity:0;scale:.6}60%{opacity:1;scale:1.04}80%{scale:.98}100%{scale:1}}
@keyframes grow{0%{scale:1 0}70%{scale:1 1.08}100%{scale:1 1}}
.anim .hero,.anim .stage,.anim .ad,.anim .chart{animation:pop .7s cubic-bezier(.3,1.4,.5,1) backwards}
.anim .stage:nth-of-type(3){animation-delay:.08s}.anim .stage:nth-of-type(5){animation-delay:.16s}
.anim .bars .b{animation:grow .6s cubic-bezier(.3,1.4,.5,1) backwards;animation-delay:calc(var(--i) * 12ms)}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
.trio .v{white-space:nowrap}
@media (max-width:520px){.grid,.ad .grid{grid-template-columns:1fr 1fr}.grid .v{font-size:24px}.src .r{grid-template-columns:minmax(0,1fr) 50px 50px 44px}.stage .n{font-size:38px}.trio .v{font-size:24px}.trio .cap{font-size:10px}.trio{grid-template-columns:1fr 1fr}.trio div:last-child{grid-column:span 2}h2{font-size:26px}}

/* tabs */
.tabs{display:flex;gap:6px;margin:0 0 16px;background:var(--card-2);padding:4px;border-radius:999px;width:max-content}
.tabs a{padding:8px 16px;border-radius:999px;font-size:13px;color:var(--ink-2);text-decoration:none}
.tabs a[aria-current=page]{background:var(--ink);color:var(--bg);font-weight:600}
.tabs a:focus-visible{outline:2px solid var(--pink);outline-offset:2px}
/* jars */
.jl{background:var(--card-2);border-radius:20px;padding:4px 16px}
.jr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:12px 0;border-top:1px solid var(--rule)}
.jr:first-child{border-top:0}
.jr .nm{font-size:14px;color:var(--ink);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jr a.nm:hover{color:var(--pink)}
.jr .am{font-family:"HN";font-size:22px;font-variation-settings:"wght" 800,"wdth" 520;text-align:right;white-space:nowrap}
.jr .am small{font-family:system-ui,sans-serif;font-size:11px;color:var(--ink-3);font-variation-settings:normal;text-transform:none;margin-left:4px}
.jr .bar{grid-column:1/-1;height:6px;border-radius:3px;background:var(--rule);overflow:hidden}
.jr .bar i{display:block;height:100%;width:var(--w);background:var(--pink);border-radius:3px;transition:width .6s}
.jr.done .bar i{background:#fff}
.jr .meta{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--ink-3)}
.jr .meta .up{color:var(--pink);font-weight:600}
.jr.flash{animation:flash 1.6s}
@keyframes flash{0%{background:rgba(254,117,190,.25)}100%{background:none}}
.nojar{margin-top:10px;font-size:13px;color:var(--ink-3)}
.hero .big.jb{font-size:clamp(64px,19vw,170px)}
</style></head><body><main>`;

function page(data) {
  return head('Воронка', '<meta http-equiv="refresh" content="300">') + `
<nav class="tabs"><a href="/api/dashboard" aria-current="page">Квитки</a><a href="/api/dashboard?tab=jars">Банки</a></nav>
<div class="top"><span class="live"><i></i>live</span><span class="count">до фестивалю <b id="cd"></b> днів</span></div>
<div class="per" role="group" aria-label="Період"><button data-p="1">Сьогодні</button><button data-p="7" aria-pressed="true">7 днів</button><button data-p="30">30 днів</button><button data-p="all">Весь час</button></div>
<div id="app"></div>
<details><summary>Питання й відповіді</summary><dl class="how">
<dt>Прийшли на сайт</dt><dd>Унікальні відвідувачі сайту за період (Google Analytics, лише потік цього сайту). Рахуються лише ті, хто дав згоду на cookies: поза ЄС — усі, у ЄС — після «Дивіться» в банері. Люди з блокувальниками реклами сюди не потрапляють — реальних відвідувачів трохи більше.</dd>
<dt>Натиснули «Купити квиток»</dt><dd>Кліки на будь-яку кнопку купівлі на сайті (подія <code>begin_checkout</code>). Дві спроби однієї людини — два кліки. Ті самі правила згоди, що й для відвідувачів.</dd>
<dt>Оплатили</dt><dd>Унікальні успішні замовлення на WayForPay. Після кожної оплати WayForPay повідомляє наш сервер, і той одразу записує замовлення у власну базу (номер, кількість квитків, сума, час — без особистих даних) — тому оплати видно тут <b>за кілька секунд</b>, рахуються всі, навіть без згоди на cookies, і повторні повідомлення не задвоюються. Оплати 6–7 жовтня, до появи бази, взято з Google. Одне замовлення може містити кілька квитків.</dd>
<dt>Квитки, замовлення й повернення</dt><dd>Головне число — <b>квитки</b>: одне замовлення може містити кілька (кількість приходить від WayForPay). У воронці «Оплатили» — <b>замовлення</b>, тобто люди, які оплатили. Якщо кошти за замовлення повернули, WayForPay повідомляє наш сервер — і таке замовлення разом з його квитками більше не рахується, а в рожевому блоці зʼявляється «повернено N». Повернення до 07.10.2026 і тестові покупки виключено вручну.</dd>
<dt>Чому оплат більше, ніж кліків «Купити»?</dt><dd>Бо їх рахують різні джерела. Кліки — лише на сайті і лише в тих, хто дав згоду на cookies і не має блокувальника реклами. Оплати — усі: їх повідомляє WayForPay. До того ж частина покупців узагалі не натискає «Купити» на сайті: відкриває оплату з біо Instagram, з реклами, що веде одразу на WayForPay, з пересланого в чаті посилання чи закладки. Тому «оплатили з кліків» може бути понад 100% — це не помилка, а знак, що люди купують і повз сайт. Справжню конверсію краще дивитися як «від відвідувача до оплати».</dd>
<dt>% між кроками</dt><dd>Скільки дійшло до кроку від попереднього. Оплати рахуються за всіма покупцями, а кліки — лише за тими, хто дав згоду, тож «оплатили з кліків» буває завищеним, а іноді й понад 100%. Ширина блоків воронки — наочна, не в масштабі; точні числа — на блоках.</dd>
<dt>Порівняння з попереднім періодом</dt><dd>«Сьогодні» — з учора; «7 днів» — з попередніми 7 днями; «30 днів» — з попередніми 30. «Весь час» — від 6 жовтня 2026, коли почалося відстеження оплат; порівняння немає.</dd>
<dt>«Разом»</dt><dd><b>Виручка</b> — сума всіх оплачених замовлень (з нашої бази, без повернених). <b>Витрачено на рекламу</b> — увесь рекламний кабінет Meta за період. <b>Реклама на 1 квиток</b> — витрачено / усі продані квитки, звідки б покупець не прийшов. <b>Окупність</b> — виручка / витрачено: скільки гривень виручки припадає на гривню реклами. Це загальна картина — частина покупців прийшла б і без реклами.</dd>
<dt>Що показує блок «Реклама Meta»?</dt><dd>Увесь окремий рекламний кабінет фестивалю (з 08.11.2026). <b>Квиток з реклами</b> — витрачено / покупки, які Meta зарахувала рекламі: людина клікнула рекламу до 7 днів або побачила її до 1 дня перед покупкою (стандартне налаштування кабінету). Покупки Meta дізнається з нашого сервера (Conversions API) — для цього кабінет має бути підключений до набору даних (пікселя) <code>1647718446547735</code>. Кабінет фестивалю рахує в доларах: витрати й суми покупок переведено в гривні за сьогоднішнім курсом НБУ (курс видно над блоком), тому за минулі дні суми в гривнях можуть трохи відрізнятися від тих, що були насправді. <b>Клікнули → Відкрили сайт</b>: частина людей закриває сторінку, не дочекавшись завантаження; «Відкрили сайт» Meta рахує лише в тих, хто дав згоду на cookies. Покупки, які Meta приписує рекламі, і всі оплати з «Разом» рахуються по-різному — Meta може приписати рекламі й покупку, яка сталася б і без неї.</dd>
<dt>«Звідки прийшли» і UTM-мітки</dt><dd>Таблиця під воронкою сайту — групи каналів Google Analytics: скільки відвідувачів і кліків «Купити» дав кожен канал. Щоб Google відрізняв рекламу Meta від звичайних переходів з Instagram і Facebook, у кожному оголошенні в полі «Параметри URL» має стояти: <code>utm_source={{site_source_name}}&amp;utm_medium=paid_social&amp;utm_campaign={{campaign.name}}&amp;utm_content={{ad.name}}</code>. Без міток такі відвідувачі потрапляють у «Соцмережі (не реклама)».</dd>
<dt>Як дати дашборду доступ до кабінету Meta</dt><dd>Токенові <code>META_ADS_TOKEN</code> потрібне право <code>ads_read</code> саме на цей кабінет. Найнадійніше — системний користувач бізнес-менеджера: «Налаштування компанії» → «Системні користувачі» → користувач → «Призначити ресурси» → рекламний кабінет → «Переглядати ефективність»; потім «Згенерувати токен» з правом <code>ads_read</code> і вставити його у Vercel (<code>META_ADS_TOKEN</code>).</dd>
<dt>Дні й оновлення</dt><dd>Дні — за київським часом. Сторінка оновлюється сама кожні 5 хв. Квитки й оплати — миттєво (з нашої бази). Відвідувачі й кліки «Купити» — з Google, який домальовує дані від кількох хвилин до 24–48 год, тож за сьогодні вони ще можуть зрости, і «оплатили з кліків» сьогодні буває завищеним.</dd>
</dl></details>
<p class="foot">Оновлено ${esc(data.updated)} (Київ)</p>
</main>
<script>
const D=${JSON.stringify(data).replace(/</g, '\\u003c')};
const fmt=n=>Math.round(n).toLocaleString('uk-UA'), pct=(a,b)=>b?(a/b*100).toFixed(a/b<.1?1:0)+'%':'—';
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e};
const app=document.getElementById('app'), reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const G=D.ga&&!D.ga.error?D.ga:null, M=D.meta&&!D.meta.error?D.meta:null, S=D.sales||null;
const sum=(ds,o)=>ds.reduce((a,d)=>a+((o||{})[d]||0),0);
const plural=(n,a,b,c)=>{n=Math.abs(n)%100;const m=n%10;return n>10&&n<20?c:m===1?a:m>=2&&m<=4?b:c};
document.getElementById('cd').textContent=Math.max(0,Math.ceil((Date.parse('2026-11-22T11:00:00Z')-Date.now())/864e5));
/* numbers count up once */
function count(node,to,suffix){suffix=suffix||'';if(reduce||!to){node.textContent=fmt(to)+suffix;return}const t0=performance.now(),dur=700;const f=t=>{const k=Math.min(1,(t-t0)/dur),e=1-Math.pow(1-k,3);node.textContent=fmt(to*e)+suffix;if(k<1)requestAnimationFrame(f)};requestAnimationFrame(f)}
let first=true;
const TRACK='2026-10-06';  /* з цього дня оплати відстежуються (обробник WayForPay → GA) */
function render(p){
  app.replaceChildren();app.classList.toggle('anim',first&&!reduce);
  const all=p==='all';
  const ds=all?D.days.filter(d=>d>=TRACK):D.days.slice(-p), prev=all?[]:D.days.slice(-2*p,-p);
  const v=G?sum(ds,G.visitors):0,c=G?sum(ds,G.clicks):0,b=S?sum(ds,S.purchases):0,tk=S?sum(ds,S.tickets):0,tkp=S?sum(prev,S.tickets):0,rf=S?sum(ds,S.refunds):0;
  const label=all?'з 6 жовтня':p===1?'сьогодні':'за '+p+' днів', prevLabel=p===1?'учора':'за попередні '+p+' днів';

  /* hero */
  const h=el('section','hero');h.append(el('div','cap','Квитків продано '+label));
  const big=el('div','hn big');h.append(big);
  const row=el('div','row');
  if(S&&all)row.append(el('span','chip','від початку відстеження'));
  if(S&&!all){const d=tk-tkp;const ch=el('span','chip'+(d>0?' up':''),d>0?'↑ на '+d+' більше, ніж '+prevLabel:d<0?'↓ на '+Math.abs(d)+' менше, ніж '+prevLabel:'стільки ж, як '+prevLabel);row.append(ch);
    }
  if(S){row.append(el('span',null,'з '+fmt(b)+' '+plural(b,'замовлення','замовлень','замовлень')+(rf?' · повернено '+fmt(rf):'')+(v?' · купили '+pct(b,v)+' відвідувачів':'')))}
  else row.append(el('span',null,D.ga?'Google: '+D.ga.error:'Google Analytics ще не підключено'));
  h.append(row);app.append(h);count(big,tk);

  /* the money side, all of it: every ticket, every hryvnia of ads */
  const rv=S?sum(ds,S.revenue):0, spAll=M?sum(ds,M.spend):0;
  const card=(l,val,n,hl)=>{const d=el('div',hl?'hl':null);d.append(el('div','cap',l),el('div','v',val));if(n)d.append(el('small',null,n));return d};
  const tt=el('h2');tt.append(document.createTextNode('Разом '),el('i',null,label));app.append(tt);
  const tg=el('div','grid');
  tg.append(card('Виручка',S?fmt(rv)+' грн':'—',S?fmt(tk)+' '+plural(tk,'квиток','квитки','квитків')+' · '+fmt(b)+' '+plural(b,'замовлення','замовлення','замовлень'):''),
    card('Витрачено на рекламу',M?fmt(spAll)+' грн':'—',M?'весь кабінет Meta'+(M.currency&&M.currency!=='UAH'?' · ≈ '+fmt(spAll/M.rate)+' '+M.currency:''):'Meta не підключено'),
    card('Реклама на 1 квиток',M&&tk?fmt(spAll/tk)+' грн':'—','витрачено / усі квитки'),
    card('Окупність реклами',M&&spAll?(rv/spAll).toFixed(1).replace('.',',')+'×':'—',M&&spAll?'кожна гривня реклами → '+fmt(rv/spAll)+' грн виручки':'виручка / витрачено',true));
  app.append(tg);

  /* ads: what the ads did, by Meta's own count */
  const a=el('h2');a.append(document.createTextNode('Реклама '),el('i',null,'Meta'));app.append(a);
  if(M){const sp=spAll,im=sum(ds,M.impressions),cl=sum(ds,M.clicks),vw=sum(ds,M.views),co=sum(ds,M.checkouts),mb=sum(ds,M.purchases),mv=sum(ds,M.value);
    const fx=M.currency&&M.currency!=='UAH';
    app.append(el('p','sub','Кабінет '+M.account+(M.filtered?' · лише кампанії з «'+M.match.join('», «')+'»':' · усі кампанії')+'. Покупки й виручка — ті, що Meta приписує рекламі.'+(fx?' Кабінет рахує в '+M.currency+' — суми переведено в гривні за курсом НБУ на сьогодні: 1 '+M.currency+' = '+M.rate.toFixed(2).replace('.',',')+' грн.':'')));
    const box=el('section','ad');const say=el('div','say');say.append(document.createTextNode('Квиток з реклами коштує'),el('b',null,mb?fmt(sp/mb)+' грн':'—'),document.createTextNode(mb?'':' — реклама ще не принесла покупок за цей період'));box.append(say);
    const g=el('div','grid');g.style.marginTop='16px';
    g.append(card('Витрачено',fmt(sp)+' грн',fx?'≈ '+fmt(sp/M.rate)+' '+M.currency+' у кабінеті':''),card('Кліки на посилання',fmt(cl),im?'CTR '+pct(cl,im)+' з '+fmt(im)+' показів':''),card('Ціна кліку',cl?(sp/cl).toFixed(1).replace('.',',')+' грн':'—',''),
      card('Покупок з реклами',fmt(mb),'за даними Meta'),card('Виручка з реклами',fmt(mv)+' грн',''),card('Окупність реклами',sp&&mv?(mv/sp).toFixed(1).replace('.',',')+'×':'—','виручка з реклами / витрачено',true));
    box.append(g);
    /* the ad's own funnel: shown → clicked → opened the site → began paying → bought */
    const mf=el('div','mf'),steps=[['Побачили рекламу (покази)',im],['Клікнули на посилання',cl],['Відкрили сайт',vw],['Почали оплату',co],['Купили',mb]];
    steps.forEach(([l,n],i)=>{const r=el('div');r.style.setProperty('--w',(im?Math.max(n?3:0,Math.sqrt(n/im)*100):0)+'%');r.append(el('span',null,l),el('b',null,fmt(n)),el('span',null,i?pct(n,steps[i-1][1]):''));mf.append(r)});
    box.append(mf);
    const cl2=el('details','camps');cl2.append(el('summary',null,'Кампанії ('+M.campaigns.filter(c=>c.used).length+')'));
    M.campaigns.forEach(c=>{const r=el('div','camp'+(c.used?'':' off'));r.append(el('span',null,c.name),el('b',null,fmt(c.spend)+' грн · '+fmt(c.purchases)+' '+plural(c.purchases,'покупка','покупки','покупок')));cl2.append(r)});
    box.append(cl2);app.append(box)}
  else{const td=el('div','todo');td.append(el('b',null,D.meta?'Meta: '+D.meta.error:'Ще не підключено.'),document.createTextNode(D.meta?' Токенові потрібен доступ «ads_read» до кабінету — див. «Питання й відповіді».':' Тут зʼявиться, скільки коштує квиток з реклами.'));app.append(td)}

  /* site: the funnel, and where the visitors came from */
  const t=el('h2');t.append(document.createTextNode('Сайт: шлях до '),el('i',null,'квитка'));app.append(t);
  const f=el('div','fun');const top=Math.max(1,v);
  const st=[['s1','Прийшли на сайт',v],['s2','Натиснули «Купити квиток»',c],['s3','Оплатили (замовлень)',b]];
  let w=100;
  st.forEach(([cls,l,n],i)=>{
    if(i){const s=el('div','step');s.append(el('b',null,pct(n,st[i-1][2])),document.createTextNode(i===1?' натиснули «Купити»':' оплатили'));
      if(st[i-1][2]&&n>st[i-1][2])s.append(el('span','why','частина покупців іде на оплату не через сайт — див. «Питання й відповіді» внизу'));f.append(s)}
    /* воронка завжди звужується: блок не ширший за попередній (ширина наочна, точні числа — на блоках) */
    w=Math.min(w,34+66*Math.sqrt(n/top));const g=el('div','stage '+cls);g.style.setProperty('--w',w+'%');
    const nn=el('div','hn n');g.append(el('div','l',l),nn);f.append(g);count(nn,n)});
  app.append(f);
  if(G&&G.channels){
    const NAME={'Paid Social':'Реклама в соцмережах','Organic Social':'Соцмережі (не реклама)','Direct':'Прямі заходи','Organic Search':'Пошук','Referral':'Інші сайти','Paid Search':'Реклама в пошуку','Paid Other':'Інша реклама','Email':'Email','Organic Video':'Відео','Display':'Банери','Unassigned':'Невідомо','Cross-network':'Реклама (кілька мереж)'};
    const rows=Object.entries(G.channels).map(([k,x])=>({k,name:NAME[k]||k,u:sum(ds,x.users),c:sum(ds,x.clicks)})).filter(r=>r.u||r.c).sort((x,y)=>y.u-x.u);
    if(rows.length){const box=el('div','src');const hd=el('div','r');['Звідки','Люди','«Купити»','%'].forEach(x=>hd.append(el('span',null,x)));box.append(hd);
      rows.forEach(r=>{const x=el('div','r'+(/^Paid|Cross/.test(r.k)?' ad':''));x.append(el('span',null,r.name),el('b',null,fmt(r.u)),el('b',null,fmt(r.c)),el('span',null,pct(r.c,r.u)));box.append(x)});
      app.append(box);app.append(el('p','note','За групами каналів Google Analytics. Перехід із реклами Meta Google бачить як «Реклама в соцмережах» лише тоді, коли в посиланні реклами є UTM-мітки (див. «Питання й відповіді»); без них такі відвідувачі потрапляють у «Соцмережі (не реклама)».'))}
  }

  /* days */
  if(S){
    const days=all?ds:D.days.slice(-(p===1?14:p));
    const dh=el('h2');dh.append(document.createTextNode('По '),el('i',null,'днях'));app.append(dh);
    const ch=el('section','chart');const bars=el('div','bars');const max=Math.max(1,...days.map(d=>S.tickets[d]||0));
    const best=days.reduce((a,d)=>(S.tickets[d]||0)>(S.tickets[a]||0)?d:a,days[0]);
    const read=el('div','read');
    const show=d=>{read.replaceChildren();const dd=el('span','d');dd.append(el('b',null,d.slice(8)+'.'+d.slice(5,7)));read.append(dd);
      const W=(n,a,b,c)=>plural(n||0,a,b,c);
      [[S.tickets[d],W(S.tickets[d],'квиток','квитки','квитків')],[S.purchases[d],W(S.purchases[d],'замовлення','замовлення','замовлень')],[(S.revenue||{})[d],'грн виручки']].concat(G?[[G.clicks[d],W(G.clicks[d],'клік','кліки','кліків')+' «Купити»'],[G.visitors[d],W(G.visitors[d],'відвідувач','відвідувачі','відвідувачів')]]:[]).concat(M?[[M.spend[d],'грн на рекламу']]:[]).forEach(([x,l])=>{const s=el('span');s.append(el('b',null,fmt(x||0)),document.createTextNode(' '+l));read.append(s)});
      bars.querySelectorAll('button').forEach(x=>x.setAttribute('aria-current',x.dataset.d===d?'true':'false'))};
    days.forEach((d,i)=>{const x=S.tickets[d]||0;const btn=el('button');btn.dataset.d=d;btn.setAttribute('aria-label',d+': '+x+' квитків');
      const bar=el('div','b'+(x?'':' zero'));bar.style.height=(x/max*100)+'%';bar.style.setProperty('--i',i);btn.append(bar);
      if(d===best&&(S.tickets[d]||0)>0){const tag=el('span','best','рекорд');tag.style.setProperty('--h',(x/max*100)+'%');btn.append(tag)}
      btn.addEventListener('pointerenter',()=>show(d));btn.addEventListener('focus',()=>show(d));btn.addEventListener('click',()=>show(d));bars.append(btn)});
    ch.append(bars);const ax=el('div','axis');ax.append(el('span',null,days[0].slice(8)+'.'+days[0].slice(5,7)),el('span',null,'сьогодні'));ch.append(ax,read);app.append(ch);show(days[days.length-1]);
  }
  if(D.ga&&D.ga.error)app.append(el('div','err','Google: '+D.ga.error));
  first=false;
}
const btns=[...document.querySelectorAll('.per button')];
btns.forEach(x=>x.addEventListener('click',()=>{btns.forEach(y=>y.setAttribute('aria-pressed',y===x?'true':'false'));render(x.dataset.p==='all'?'all':+x.dataset.p)}));
render(7);
</script></body></html>`;
}

/* ---------- вкладка «Банки» ---------- */
function jarsPage(J) {
  return head('Банки', '') + `
<nav class="tabs"><a href="/api/dashboard">Квитки</a><a href="/api/dashboard?tab=jars" aria-current="page">Банки</a></nav>
<div class="top"><span class="live"><i></i>live</span><span class="count" id="upd"></span></div>
<div id="app"></div>
<details><summary>Питання й відповіді</summary><dl class="how">
<dt>Звідки суми</dt><dd>Просто з Monobank: дашборд дивиться кожну банку так само, як її сторінку send.monobank.ua, — без ключів і без доступу до рахунків. Суми оновлюються самі кожні 30 секунд, перезавантажувати сторінку не треба. Закриті банки теж рахуються — з тією сумою, з якою їх закрили.</dd>
<dt>Звідки список збирачів</dt><dd>З таблиці Notion «Збирачі та банкіри». Дашборд перечитує її раз на 6 годин: нова людина з банкою зʼявиться тут протягом 6 годин після того, як її внесли в таблицю. Хто в таблиці без посилання на банку — показані внизу, у «Ще без банки». Одна людина з кількома банками — кілька рядків.</dd>
<dt>«Сьогодні» і «за годину»</dt><dd>Скільки додалося з кінця вчорашнього дня і з минулої години. Дашборд щогодини, коли його відкривають, запамʼятовує суми всіх банок; якщо його довго ніхто не відкривав, «сьогодні» рахується від першого знімка сьогодні (це видно в підписі). Сама сума «Зібрано» завжди точна.</dd>
<dt>Ціль</dt><dd>Сума цілей усіх банок, як їх поставили збирачі в Monobank. Банка «досягла цілі», якщо зібрано не менше, ніж її ціль.</dd>
</dl></details>
<p class="foot" id="foot"></p>
</main>
<script>
let J=${JSON.stringify(J).replace(/</g, '\\u003c')};
const fmt=n=>Math.round(n).toLocaleString('uk-UA');
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e};
const app=document.getElementById('app'), reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const plural=(n,a,b,c)=>{n=Math.abs(n)%100;const m=n%10;return n>10&&n<20?c:m===1?a:m>=2&&m<=4?b:c};
const card=(l,val,n,hl)=>{const d=el('div',hl?'hl':null);d.append(el('div','cap',l),el('div','v',val));if(n)d.append(el('small',null,n));return d};
let shown=0,last={};
function count(node,from,to){if(reduce||from===to){node.textContent=fmt(to);return}const t0=performance.now(),dur=900;const f=t=>{const k=Math.min(1,(t-t0)/dur),e=1-Math.pow(1-k,3);node.textContent=fmt(from+(to-from)*e);if(k<1)requestAnimationFrame(f)};requestAnimationFrame(f)}
/* snapshot sums for the jars on the list now */
const total=(snap,ids)=>ids.reduce((a,id)=>a+((snap||{})[id]||0),0);
function render(){
  const P=J.people.filter(p=>p.jar&&typeof p.amount==='number'), ids=[...new Set(P.map(p=>p.jar))];
  const byJar=Object.fromEntries(P.map(p=>[p.jar,p]));
  const sum=ids.reduce((a,id)=>a+byJar[id].amount,0), goal=ids.reduce((a,id)=>a+(byJar[id].goal||0),0);
  /* hist: 'YYYY-MM-DDTHH' — the last sums of the hour, 'YYYY-MM-DDTHHf' — the first ones */
  const keys=Object.keys(J.hist).filter(k=>k.length===13).sort(), today=J.hour.slice(0,10), F=k=>J.hist[k+'f']?k+'f':k;
  const before=keys.filter(k=>k<today+'T00'), todayKeys=keys.filter(k=>k.startsWith(today));
  const baseKey=before.length?before[before.length-1]:todayKeys[0]&&F(todayKeys[0]), hourKey=keys.filter(k=>k<J.hour).pop()||(J.hist[J.hour+'f']?J.hour+'f':undefined);
  const base=baseKey?J.hist[baseKey]:null, hb=hourKey?J.hist[hourKey]:null;
  const dToday=base?sum-total(base,ids.filter(id=>id in base)):0, dHour=hb?sum-total(hb,ids.filter(id=>id in hb)):0;
  const todayNote=before.length?'з кінця вчорашнього дня':baseKey?'від '+baseKey.slice(11,13)+':00 — раніше знімків немає':'';
  app.replaceChildren();
  const h=el('section','hero');h.append(el('div','cap','Зібрано в банках'));
  const big=el('div','hn big jb');h.append(big);
  const row=el('div','row');
  if(dToday>0)row.append(el('span','chip up','+'+fmt(dToday)+' грн сьогодні'));
  row.append(el('span',null,'гривень · ціль '+fmt(goal)+' грн · '+(goal?Math.round(sum/goal*100):0)+'%'));
  h.append(row);app.append(h);count(big,shown,sum);shown=sum;
  const closed=ids.filter(id=>byJar[id].closed).length, done=ids.filter(id=>byJar[id].goal&&byJar[id].amount>=byJar[id].goal).length;
  const g=el('div','grid');g.style.marginTop='22px';
  g.append(card('Банок',fmt(ids.length),closed?'з них закрито '+closed:'усі відкриті'),
    card('Досягли цілі',fmt(done)+' з '+fmt(ids.length),''),
    card('Сьогодні','+'+fmt(dToday)+' грн',todayNote,true),
    card('За цю годину','+'+fmt(dHour)+' грн',hourKey?(hourKey.endsWith('f')?'від '+hourKey.slice(11,13)+':00':'від кінця '+hourKey.slice(11,13)+'-ї години'):'ще немає знімка'));
  app.append(g);
  /* days: how much came in each day (by the last snapshot of the day) */
  const dayKeys=[...new Set(keys.map(k=>k.slice(0,10)))];
  if(dayKeys.length>1){
    const t=el('h2');t.append(document.createTextNode('По '),el('i',null,'днях'));app.append(t);
    const end=d=>{const k=keys.filter(x=>x.startsWith(d)).pop();const s=J.hist[k];return total(s,ids.filter(id=>id in s))};
    const vals=dayKeys.map((d,i)=>i?Math.max(0,end(d)-end(dayKeys[i-1])):null).slice(1), ds=dayKeys.slice(1), mx=Math.max(1,...vals);
    const c=el('div','chart'),bars=el('div','bars'),read=el('div','read');
    const show=i=>{read.replaceChildren();const a=el('span','d',new Date(ds[i]+'T12:00').toLocaleDateString('uk-UA',{day:'numeric',month:'long'}));const b=el('span');b.append(el('b',null,'+'+fmt(vals[i])),document.createTextNode(' грн'));read.append(a,b);[...bars.children].forEach((x,j)=>x.setAttribute('aria-current',j===i?'true':'false'))};
    vals.forEach((v,i)=>{const b=el('button');b.setAttribute('aria-label',ds[i]+': '+fmt(v)+' грн');const s=el('div','b'+(v?'':' zero'));s.style.height=(v/mx*100)+'%';s.style.setProperty('--i',i);b.append(s);b.addEventListener('click',()=>show(i));b.addEventListener('mouseenter',()=>show(i));bars.append(b)});
    const ax=el('div','axis');ax.append(el('span',null,ds[0].slice(8)+'.'+ds[0].slice(5,7)),el('span',null,ds[ds.length-1].slice(8)+'.'+ds[ds.length-1].slice(5,7)));
    c.append(bars,ax,read);app.append(c);show(vals.length-1);
  }
  /* collectors, most collected first */
  const t2=el('h2');t2.append(document.createTextNode('Збирачі '),el('i',null,fmt(P.length)));app.append(t2);
  const L=el('div','jl');
  [...J.people.filter(p=>p.jar)].sort((a,b)=>(b.amount||0)-(a.amount||0)).forEach(p=>{
    const ok=typeof p.amount==='number', fin=ok&&p.goal&&p.amount>=p.goal;
    const r=el('div','jr'+(fin?' done':''));
    const nm=el('a','nm',p.name);nm.href='https://send.monobank.ua/jar/'+p.jar;nm.target='_blank';nm.rel='noopener';
    const am=el('div','am',ok?fmt(p.amount):'—');if(ok&&p.goal)am.append(el('small',null,'/ '+fmt(p.goal)));
    const bar=el('div','bar'),bi=el('i');bi.style.setProperty('--w',(ok&&p.goal?Math.min(100,p.amount/p.goal*100):0)+'%');bar.append(bi);
    const meta=el('div','meta');
    if(ok&&p.goal)meta.append(el('span',null,Math.round(p.amount/p.goal*100)+'%'));
    if(fin)meta.append(el('span',null,'ціль досягнута'));
    if(p.closed)meta.append(el('span',null,'банка закрита'));
    const d=ok&&base&&(p.jar in base)?p.amount-base[p.jar]:0;if(d>0)meta.append(el('span','up','+'+fmt(d)+' сьогодні'));
    if(!ok)meta.append(el('span',null,'Monobank не відповів: '+(p.error||'')));
    if(p.stale)meta.append(el('span',null,'сума з попереднього оновлення'));
    r.append(nm,am,bar,meta);
    if(ok&&last[p.jar]!=null&&p.amount>last[p.jar])r.classList.add('flash');
    if(ok)last[p.jar]=p.amount;
    L.append(r)});
  app.append(L);
  const no=J.people.filter(p=>!p.jar);
  if(no.length)app.append(el('p','nojar','Ще без банки ('+no.length+'): '+no.map(p=>p.name).join(', ')));
  document.getElementById('upd').textContent='оновлено '+J.updated.slice(11,16);
  document.getElementById('foot').textContent='Суми — Monobank, оновлено '+J.updated.slice(0,16).replace('T',' ')+' (Київ), щопівхвилини. Список збирачів — з Notion, '+J.listUpdated+(J.listError?' (зараз Notion не відповідає — список зі збереженого)':'')+'.';
}
render();
setInterval(async()=>{if(document.hidden)return;try{const r=await fetch('/api/dashboard?jars',{cache:'no-store'});if(r.ok){J=await r.json();render()}}catch(e){}},30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)fetch('/api/dashboard?jars',{cache:'no-store'}).then(r=>r.ok&&r.json()).then(x=>{if(x){J=x;render()}}).catch(()=>{})});
</script></body></html>`;
}

/* ---------- обробник ---------- */
let cache = { at: 0, html: '' };
const html = s => new Response(s, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' } });

export async function handle(request, env = process.env) {
  /* лише на *.vercel.app (і локально) — на основному домені сторінки немає (рішення власника 06.10.2026) */
  const host = new URL(request.url).hostname;
  if (!(host.endsWith('.vercel.app') || host === 'localhost' || host === '127.0.0.1')) return new Response('Not found', { status: 404, headers: { 'x-robots-tag': 'noindex' } });

  /* відкрито без пароля (рішення власника 06.10.2026); якщо задано DASHBOARD_PASSWORD — питає пароль */
  const pass = env.DASHBOARD_PASSWORD || '';
  if (pass) {
    const h = request.headers.get('authorization') || '';
    const given = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
    if (!(given.length === pass.length && timingSafeEqual(Buffer.from(given), Buffer.from(pass)))) return new Response('Потрібен пароль', { status: 401, headers: { 'www-authenticate': 'Basic realm="dashboard", charset="UTF-8"', 'x-robots-tag': 'noindex' } });
  }

  const qs = new URL(request.url).searchParams;
  /* вкладка «Банки»: сторінка і JSON для оновлення щопівхвилини */
  if (qs.has('jars') || qs.get('tab') === 'jars') {
    try {
      const J = await jars(env, fetch, { force: qs.has('fresh') });
      if (qs.has('jars')) return new Response(JSON.stringify(J), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
      return html(jarsPage(J));
    } catch (e) {
      if (qs.has('jars')) return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      return html(head('Банки', '<meta http-equiv="refresh" content="60">') + `<nav class="tabs"><a href="/api/dashboard">Квитки</a><a href="/api/dashboard?tab=jars" aria-current="page">Банки</a></nav><div class="todo"><b>Не вдалося отримати банки.</b> ${esc(e.message)}. Сторінка спробує ще раз за хвилину.</div></main></body></html>`);
    }
  }
  const fresh = qs.has('fresh');
  if (!fresh && cache.html && Date.now() - cache.at < 5 * 60 * 1000) return html(cache.html);

  const now = Math.floor(Date.now() / 1000), today = kyivDate(now), from = kyivDate(now - 59 * DAY);  // 60 днів: період + попередній такий самий для порівняння
  const data = {
    updated: new Date(now * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/Kyiv' }).slice(0, 16),
    month: new Date(now * 1000).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv', month: 'long' }),
    today, days: days(from, today)
  };
  let db = null;
  await Promise.all([
    allOrders(env).then(x => { db = x; }, e => { data.dbError = e.message; }),
    env.GA4_PROPERTY_ID && (env.GA4_SA_JSON || (env.GCP_PROJECT_NUMBER && env.GCP_SERVICE_ACCOUNT_EMAIL)) ? googleToken(env, request.headers.get('x-vercel-oidc-token') || env.VERCEL_OIDC_TOKEN).then(t => ga4(env.GA4_PROPERTY_ID, t, from, env.GA4_STREAM_ID || GA4_STREAM, String(env.DASHBOARD_EXCLUDE_ORDERS || '').split(',').map(x => x.trim()).filter(Boolean))).then(x => { data.ga = x; }, e => { data.ga = { error: e.message }; }) : null,
    env.META_AD_ACCOUNT_ID && env.META_ADS_TOKEN ? meta(env.META_AD_ACCOUNT_ID, env.META_ADS_TOKEN, from, today, env.META_CAMPAIGN_MATCH).then(x => { data.meta = x; }, e => { data.meta = { error: e.message }; }) : null
  ]);
  /* оплати: база (миттєво, з моменту підключення) + GA (історія до бази); одне замовлення — раз, перевага в бази */
  if (db || (data.ga && !data.ga.error)) {
    const exclude = new Set(String(env.DASHBOARD_EXCLUDE_ORDERS || '').split(',').map(x => x.trim()).filter(Boolean));
    const g = data.ga && !data.ga.error ? data.ga : { orders: {}, refundedDays: {} };
    const all = {};
    for (const [id, o] of Object.entries(g.orders || {})) all[id] = { day: o.day, tickets: o.tickets, amount: o.amount || 0, refunded: id in (g.refundedDays || {}), rday: (g.refundedDays || {})[id] };
    for (const [id, o] of Object.entries(db || {})) all[id] = { day: kyivDate(o.t), tickets: o.tickets, amount: Number(o.amount) || 0, refunded: o.status === 'refunded', rday: o.rt ? kyivDate(o.rt) : kyivDate(o.t) };
    for (const id of Object.keys(g.refundedDays || {})) if (all[id]) { all[id].refunded = true; all[id].rday = all[id].rday || g.refundedDays[id]; }
    const sales = { purchases: {}, tickets: {}, revenue: {}, refunds: {}, source: db ? (data.ga && !data.ga.error ? 'db+ga' : 'db') : 'ga' };
    for (const [id, o] of Object.entries(all)) {
      if (exclude.has(id)) continue;
      if (o.refunded) { sales.refunds[o.rday] = (sales.refunds[o.rday] || 0) + 1; continue; }
      sales.purchases[o.day] = (sales.purchases[o.day] || 0) + 1; sales.tickets[o.day] = (sales.tickets[o.day] || 0) + o.tickets;
      sales.revenue[o.day] = (sales.revenue[o.day] || 0) + o.amount;
    }
    data.sales = sales;
  }
  if (data.ga) { delete data.ga.orders; delete data.ga.refundedDays; }
  cache = { at: Date.now(), html: page(data) };
  return html(cache.html);
}

export function GET(request) { return handle(request); }
