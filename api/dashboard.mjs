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
   DASHBOARD_PASSWORD                 — необовʼязково: якщо задати, сторінка питатиме пароль (логін будь-який) */
import { createSign, timingSafeEqual } from 'node:crypto';

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
async function ga4(propertyId, accessToken, from, stream = GA4_STREAM) {
  const tok = { access_token: accessToken };
  const byStream = { filter: { fieldName: 'streamId', stringFilter: { value: stream } } };
  const withStream = f => ({ andGroup: { expressions: [byStream, ...(f ? [f] : [])] } });
  const run = async body => {
    const r = await (await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ dateRanges: [{ startDate: from, endDate: 'today' }], dimensions: [{ name: 'date' }], limit: 400, ...body }) })).json();
    if (r.error) throw new Error(`Google: ${r.error.message}`);
    const out = {}; for (const row of r.rows || []) { const d = row.dimensionValues[0].value; out[`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`] = Number(row.metricValues[0].value); } return out;
  };
  const event = name => ({ metrics: [{ name: 'eventCount' }], dimensionFilter: withStream({ filter: { fieldName: 'eventName', stringFilter: { value: name } } }) });
  const [visitors, clicks, purchases] = await Promise.all([run({ metrics: [{ name: 'totalUsers' }], dimensionFilter: withStream() }), run(event('begin_checkout')), run(event('purchase'))]);
  return { visitors, clicks, purchases };
}

/* ---------- Meta Marketing API: витрати й покупки, які Meta приписує рекламі ---------- */
async function meta(account, token, from, to) {
  const id = String(account).startsWith('act_') ? account : `act_${account}`;
  const u = `https://graph.facebook.com/v21.0/${id}/insights?fields=spend,actions&time_increment=1&limit=200&time_range=${encodeURIComponent(JSON.stringify({ since: from, until: to }))}&access_token=${encodeURIComponent(token)}`;
  const j = await (await fetch(u)).json();
  if (j.error) throw new Error(`Meta: ${j.error.message}`);
  const spend = {}, purchases = {};
  for (const row of j.data || []) {
    spend[row.date_start] = Number(row.spend) || 0;
    const a = (row.actions || []).find(x => x.action_type === 'purchase' || x.action_type === 'offsite_conversion.fb_pixel_purchase');
    purchases[row.date_start] = a ? Number(a.value) : 0;
  }
  return { spend, purchases };
}

/* ---------- сторінка: темна, тонкі лінії, великі цифри шрифтом Heading Now, рожевий — акцент ---------- */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(data) {
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta http-equiv="refresh" content="300"><title>Воронка</title>
<link rel="preload" href="/assets/fonts/HeadingNowVar.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:"Heading Now";src:url(/assets/fonts/HeadingNowVar.woff2) format("woff2");font-weight:100 1000}
:root{color-scheme:dark;--bg:#161515;--ink:#f3eee8;--ink-2:#b3aca4;--ink-3:#7d7770;--rule:#2e2b29;--track:#2a2725;--accent:#fe75be;--warn:#e66767}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:820px;margin:0 auto;padding:36px 20px 64px}
.cap{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-2)}
.num{font-family:"Heading Now",system-ui,sans-serif;font-variation-settings:"wght" 480,"wdth" 560;letter-spacing:-.01em;line-height:.95}
.top{display:flex;justify-content:space-between;align-items:center;gap:16px}
.live{display:flex;align-items:center;gap:7px}.live i{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px rgba(254,117,190,.22)}
.per{display:flex;gap:18px;margin-top:28px}.per button{all:unset;cursor:pointer;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);padding-bottom:3px;border-bottom:1px solid transparent}.per button[aria-pressed=true]{color:var(--ink);border-color:var(--accent)}.per button:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
.hero{margin-top:26px}.hero .num{font-size:clamp(84px,17vw,150px);font-variation-settings:"wght" 420,"wdth" 520}
.hero p{margin:10px 0 0;color:var(--ink-2)}.hero p em{font-style:italic;color:var(--accent)}
h2{margin:44px 0 0;padding-bottom:10px;border-bottom:1px solid var(--rule);font-weight:400}
.f{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding:16px 0;border-bottom:1px solid var(--rule)}
.f .num{font-size:44px;text-align:right;grid-row:span 3;align-self:center}
.f .line{height:2px;background:var(--track);margin-top:8px}.f .line i{display:block;height:100%;background:var(--accent)}
.f .step{color:var(--ink-3);font-size:13px;min-height:1.2em}.f .step b{color:var(--accent);font-weight:500}
.strip{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--rule)}
.strip>div{padding:16px 16px 18px 0}.strip>div+div{padding-left:16px;border-left:1px solid var(--rule)}
.strip .num{font-size:34px;margin-top:6px}.strip small{display:block;color:var(--ink-3);font-size:12px;margin-top:6px}
.day{display:grid;grid-template-columns:64px 1fr repeat(3,minmax(64px,auto));gap:14px;align-items:center;padding:12px 0;border-bottom:1px solid var(--rule);font-variant-numeric:tabular-nums}
.day .d{color:var(--ink-2)}.day .bar{height:2px;background:var(--accent);justify-self:start}
.day .v{text-align:right}.day .v b{font-family:"Heading Now",system-ui,sans-serif;font-variation-settings:"wght" 480,"wdth" 560;font-size:22px;font-weight:400}
.day.head{color:var(--ink-3);font-size:11px;letter-spacing:.12em;text-transform:uppercase;padding:10px 0}
.off{padding:16px 0;color:var(--ink-2);border-bottom:1px solid var(--rule)}.off.err{color:var(--warn)}
.foot{margin-top:28px;color:var(--ink-3);font-size:12px;line-height:1.6}
@media (max-width:620px){.strip{grid-template-columns:1fr 1fr}.strip>div:nth-child(3){padding-left:0;border-left:0}.strip>div:nth-child(n+3){border-top:1px solid var(--rule)}.f .num{font-size:36px}.strip .num{font-size:27px}.day{grid-template-columns:48px 1fr auto auto}.day .m{display:none}}
</style></head><body><main>
<div class="top"><span class="cap">Воронка · ${esc(data.month)}</span><span class="cap live"><i></i>Live</span></div>
<div class="per" role="group" aria-label="Період"><button data-p="1">Сьогодні</button><button data-p="7">7 днів</button><button data-p="30" aria-pressed="true">30 днів</button></div>
<div id="app"></div>
<p class="foot">Оновлено ${esc(data.updated)} (Київ), сторінка оновлюється сама кожні 5 хв. Усі цифри воронки — Google Analytics; оплати туди шле сервер з вебхука WayForPay (з 06.10.2026). Google рахує лише тих, хто дав згоду на cookies: поза ЄС — усіх, у ЄС — після «Дивіться».</p>
</main>
<script>
const D=${JSON.stringify(data).replace(/</g, '\\u003c')};
const fmt=n=>Math.round(n).toLocaleString('uk-UA'), uah=n=>fmt(n)+' грн', pct=(a,b)=>b?(a/b*100).toFixed(a/b<.1?1:0)+'%':'—';
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e};
const app=document.getElementById('app');
const G=D.ga&&!D.ga.error?D.ga:null, M=D.meta&&!D.meta.error?D.meta:null;
const tot=(ds,o)=>ds.reduce((a,d)=>a+((o||{})[d]||0),0);
const word=p=>p===1?'сьогодні':'за '+p+' днів';

function render(p){
  app.replaceChildren();
  const ds=D.days.slice(-p);
  const v=G?tot(ds,G.visitors):null, c=G?tot(ds,G.clicks):null, b=G?tot(ds,G.purchases):null;
  const sp=M?tot(ds,M.spend):null, mb=M?tot(ds,M.purchases):null;

  /* головне число — скільки оплатили */
  const h=el('div','hero');h.append(el('div','cap','Оплатили '+word(p)),el('div','num',G?fmt(b):'—'));
  const sub=el('p');
  if(G){sub.append(el('em',null,pct(b,v)),document.createTextNode(' відвідувачів дійшли до оплати'))}
  else sub.textContent=D.ga?'':'Google Analytics ще не підключено — docs/DASHBOARD.md';
  h.append(sub);app.append(h);
  if(D.ga&&D.ga.error)app.append(el('div','off err','Google: '+D.ga.error));

  /* воронка */
  app.append(el('h2','cap','Воронка'));
  const steps=[['Прийшли на сайт',v],['Натиснули «Купити квиток»',c],['Оплатили',b]], topv=Math.max(1,v||0);
  steps.forEach(([label,val],i)=>{
    const r=el('div','f');r.append(el('div','cap',label),el('div','num',val==null?'—':fmt(val)));
    const st=el('div','step');
    if(i&&val!=null&&steps[i-1][1]){st.append(el('b',null,pct(val,steps[i-1][1])),document.createTextNode(' з попереднього кроку'))}
    r.append(st);
    const ln=el('div','line');const li=el('i');li.style.width=val==null?'0':Math.max(.8,val/topv*100)+'%';ln.append(li);r.append(ln);
    app.append(r)});

  /* реклама */
  app.append(el('h2','cap','Реклама Meta'));
  if(M){const s=el('div','strip');
    [['Витрачено',uah(sp),''],['Ціна квитка з реклами',mb?uah(sp/mb):'—','витрати / покупки з реклами'],['Покупок з реклами',fmt(mb),'за даними Meta'],['На будь-який квиток',b?uah(sp/b):'—','витрати / усі оплати']].forEach(([l,val,n])=>{const d=el('div');d.append(el('div','cap',l),el('div','num',val));if(n)d.append(el('small',null,n));s.append(d)});
    app.append(s)}
  else app.append(el('div','off'+(D.meta?' err':''),D.meta?'Meta: '+D.meta.error:'Ще не підключено — META_AD_ACCOUNT_ID і META_ADS_TOKEN (docs/DASHBOARD.md)'));

  /* по днях */
  if(p>1&&G){
    app.append(el('h2','cap','По днях, нові зверху'));
    const hd=el('div','day head');hd.append(el('span',null,'Дата'),el('span'),el('span','v m','Прийшли'),el('span','v','«Купити»'),el('span','v','Оплатили'));app.append(hd);
    const maxb=Math.max(1,...ds.map(d=>G.purchases[d]||0));
    [...ds].reverse().forEach(d=>{const r=el('div','day');const bar=el('span','bar');bar.style.width=((G.purchases[d]||0)/maxb*100)+'%';
      const vv=(cls,n)=>{const s=el('span',cls);s.append(el('b',null,fmt(n)));return s};
      r.append(el('span','d',d.slice(8)+'.'+d.slice(5,7)),bar,vv('v m',G.visitors[d]||0),vv('v',G.clicks[d]||0),vv('v',G.purchases[d]||0));app.append(r)})}
}
const btns=[...document.querySelectorAll('.per button')];
btns.forEach(x=>x.addEventListener('click',()=>{btns.forEach(y=>y.setAttribute('aria-pressed',y===x?'true':'false'));render(+x.dataset.p)}));
render(30);
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

  const fresh = new URL(request.url).searchParams.has('fresh');
  if (!fresh && cache.html && Date.now() - cache.at < 5 * 60 * 1000) return html(cache.html);

  const now = Math.floor(Date.now() / 1000), today = kyivDate(now), from = kyivDate(now - 29 * DAY);
  const data = {
    updated: new Date(now * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/Kyiv' }).slice(0, 16),
    month: new Date(now * 1000).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv', month: 'long' }),
    today, days: days(from, today)
  };
  await Promise.all([
    env.GA4_PROPERTY_ID && (env.GA4_SA_JSON || (env.GCP_PROJECT_NUMBER && env.GCP_SERVICE_ACCOUNT_EMAIL)) ? googleToken(env, request.headers.get('x-vercel-oidc-token') || env.VERCEL_OIDC_TOKEN).then(t => ga4(env.GA4_PROPERTY_ID, t, from, env.GA4_STREAM_ID || GA4_STREAM)).then(x => { data.ga = x; }, e => { data.ga = { error: e.message }; }) : null,
    env.META_AD_ACCOUNT_ID && env.META_ADS_TOKEN ? meta(env.META_AD_ACCOUNT_ID, env.META_ADS_TOKEN, from, today).then(x => { data.meta = x; }, e => { data.meta = { error: e.message }; }) : null
  ]);
  cache = { at: Date.now(), html: page(data) };
  return html(cache.html);
}

export function GET(request) { return handle(request); }
