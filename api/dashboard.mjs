/* Дашборд-воронка (рішення власника 06.10.2026): https://www.veganweekend.org/api/dashboard — відкритий, без назви проєкту.
   Три питання, щодня: скільки квитків продано і на яку суму; скільки людей прийшло і скільки натиснули «Купити»;
   скільки коштує проданий квиток з реклами Meta. Дані тягнуться на сервері, ключі в браузер не потрапляють.

   Змінні середовища (Vercel, Production):
   DASHBOARD_PASSWORD                 — необовʼязково: якщо задати, сторінка питатиме пароль (логін будь-який)
   WAYFORPAY_SECRET_KEY               — уже є (оплати)
   GA4_PROPERTY_ID, GA4_SA_JSON       — Google Analytics Data API: числовий ID ресурсу і JSON ключа службового акаунта (Viewer у GA)
   META_AD_ACCOUNT_ID, META_ADS_TOKEN — рекламний кабінет (act_…) і токен з правом ads_read
   Немає змінних для Google / Meta — відповідний блок показує, що його ще не підключено. */
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

const MERCHANT = 'everyanimal_org';
const BUTTON = '12700913';                 // кнопка оплати львівського фестивалю: WFP-SOC-12700913-…
const START = Date.UTC(2026, 8, 1) / 1000; // від 01.09.2026 — раніше продажів на Львів не було
const PRICE = d => (d >= '2026-10-07' ? 600 : 500); // ціна квитка на дату — щоб порахувати кількість (WayForPay не віддає кількість)
const DAY = 86400;

const kyivDate = ts => new Date(Number(ts) * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }); // YYYY-MM-DD за Києвом (з переходом на зимовий час)
const days = (from, to) => { const out = []; for (let t = Date.parse(from); t <= Date.parse(to); t += DAY * 1000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };

/* ---------- WayForPay: TRANSACTION_LIST, вікнами по 30 днів ---------- */
async function wayforpay(secret, now) {
  const list = [];
  for (let b = START; b < now; b += 30 * DAY) {
    const e = Math.min(b + 30 * DAY - 1, now);
    const r = await fetch('https://api.wayforpay.com/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      transactionType: 'TRANSACTION_LIST', merchantAccount: MERCHANT, apiVersion: 1, dateBegin: b, dateEnd: e,
      merchantSignature: createHmac('md5', secret).update(`${MERCHANT};${b};${e}`).digest('hex') }) });
    const j = await r.json();
    if (Number(j.reasonCode) !== 1100) {
      /* діагностика: що відповів WayForPay і що ми підписали (без ключа) */
      const cs = await (await fetch('https://api.wayforpay.com/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactionType: 'CHECK_STATUS', merchantAccount: MERCHANT, orderReference: 'WFP-SOC-12700913-6ac4b29136b28', apiVersion: 1, merchantSignature: createHmac('md5', secret).update(`${MERCHANT};WFP-SOC-12700913-6ac4b29136b28`).digest('hex') }) })).json().catch(e => ({ e: String(e) }));
      throw new Error(`WayForPay: ${JSON.stringify(j)} | signed «${MERCHANT};${b};${e}» | key len ${secret.length} | CHECK_STATUS: ${cs.reason || cs.reasonCode} ${cs.transactionStatus || ''}`);
    }
    list.push(...(j.transactionList || []));
  }
  const buttons = {};
  const sales = {};
  for (const t of list) {
    const m = String(t.orderReference || '').match(/^WFP-SOC-(\d+)-/);
    if (!m || t.transactionStatus !== 'Approved') continue;
    buttons[m[1]] = (buttons[m[1]] || 0) + 1;
    if (m[1] !== BUTTON) continue;
    const d = kyivDate(t.processingDate || t.createdDate), amount = Number(t.amount) || 0;
    const s = sales[d] || (sales[d] = { orders: 0, amount: 0, tickets: 0 });
    s.orders++; s.amount += amount; s.tickets += Math.max(1, Math.round(amount / PRICE(d)));
  }
  return { sales, buttons };
}

/* ---------- Google Analytics Data API (службовий акаунт, JWT без бібліотек) ---------- */
async function ga4(propertyId, saJson, from) {
  const sa = JSON.parse(saJson), now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')}`;
  const tok = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) })).json();
  if (!tok.access_token) throw new Error(`Google: ${tok.error_description || tok.error || 'немає доступу'}`);
  const run = async body => {
    const r = await (await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ dateRanges: [{ startDate: from, endDate: 'today' }], dimensions: [{ name: 'date' }], ...body }) })).json();
    if (r.error) throw new Error(`Google: ${r.error.message}`);
    const out = {}; for (const row of r.rows || []) { const d = row.dimensionValues[0].value; out[`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`] = Number(row.metricValues[0].value); } return out;
  };
  const [visitors, clicks] = await Promise.all([
    run({ metrics: [{ name: 'totalUsers' }] }),
    run({ metrics: [{ name: 'eventCount' }], dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'begin_checkout' } } } })
  ]);
  return { visitors, clicks };
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

/* ---------- сторінка ---------- */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(data) {
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Воронка</title>
<style>
:root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f2f1ee;--text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#7a7974;--grid:#e4e3df;--series-1:#2a78d6;--critical:#c4312f}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--surface-1:#1a1a19;--surface-2:#242423;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#8f8e86;--grid:#33332f;--series-1:#3987e5;--critical:#e66767}}
*{box-sizing:border-box}body{margin:0;background:var(--surface-1);color:var(--text-primary);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:32px 0 12px}
.sub{color:var(--text-secondary);margin:0 0 20px;font-size:13px}
.hero{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.hero b{font-size:56px;font-weight:600;line-height:1}.hero span{color:var(--text-secondary)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:16px}
.tile{background:var(--surface-2);border-radius:10px;padding:14px 16px}.tile .l{color:var(--text-secondary);font-size:13px}.tile .v{font-size:26px;font-weight:600;margin-top:2px}.tile .n{color:var(--text-muted);font-size:12px;margin-top:2px}
.off{background:var(--surface-2);border-radius:10px;padding:14px 16px;color:var(--text-secondary);font-size:14px}.err{color:var(--critical)}
.seg{display:inline-flex;background:var(--surface-2);border-radius:8px;padding:3px;gap:2px}.seg button{font:inherit;font-size:13px;border:0;background:none;color:var(--text-secondary);padding:6px 12px;border-radius:6px;cursor:pointer}.seg button[aria-pressed=true]{background:var(--surface-1);color:var(--text-primary);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.funnel{margin-top:8px}.step{display:grid;grid-template-columns:minmax(150px,1.2fr) 3fr minmax(150px,1fr);gap:12px;align-items:center;padding:6px 0}.sh{display:flex;flex-direction:column}.sl{font-weight:500}.ss,.muted{color:var(--text-muted);font-size:12px}.sv b{font-size:22px;font-weight:600}
.track{height:28px;background:var(--surface-2);border-radius:4px;overflow:hidden}.fill{height:100%;background:var(--series-1);border-radius:0 4px 4px 0}.conv{color:var(--text-secondary);font-size:13px;padding:2px 0 2px calc(min(25%,240px) + 12px)}
@media (max-width:640px){.step{grid-template-columns:1fr auto;grid-template-areas:'h v' 'b b'}.sh{grid-area:h}.track{grid-area:b}.sv{grid-area:v;text-align:right}.conv{padding-left:0}}
table{border-collapse:collapse;width:100%;font-size:13px;margin-top:8px;font-variant-numeric:tabular-nums}th,td{text-align:right;padding:5px 8px;border-bottom:1px solid var(--grid)}th:first-child,td:first-child{text-align:left}th{color:var(--text-secondary);font-weight:500}
details{margin-top:12px}summary{cursor:pointer;color:var(--text-secondary);font-size:13px}
</style></head><body><main>
<h1>Воронка продажів</h1>
<p class="sub">Оновлено ${esc(data.updated)} (Київ) · <a href="?fresh" style="color:inherit">оновити</a></p>
<div class="seg" role="group" aria-label="Період"><button data-p="1">Сьогодні</button><button data-p="7">7 днів</button><button data-p="30" aria-pressed="true">30 днів</button></div>
<div id="app"></div>
</main>
<script>
const D=${JSON.stringify(data).replace(/</g, '\\u003c')};
const fmt=n=>Math.round(n).toLocaleString('uk-UA'), uah=n=>fmt(n)+' грн', pct=(a,b)=>b?(a/b*100).toFixed(a/b<.1?1:0)+'%':'—';
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e};
const app=document.getElementById('app');
const S=(D.wfp&&!D.wfp.error&&D.wfp.sales)||{}, G=D.ga&&!D.ga.error?D.ga:null, M=D.meta&&!D.meta.error?D.meta:null;
const tot=(days,f)=>days.reduce((a,d)=>a+(f(d)||0),0);
const tile=(l,v,n)=>{const t=el('div','tile');t.append(el('div','l',l),el('div','v',v));if(n)t.append(el('div','n',n));return t};
const note=(txt,cls)=>el('div','off'+(cls?' '+cls:''),txt);

function render(period){
  app.replaceChildren();
  const days=D.days.slice(-period);
  const visitors=G?tot(days,d=>G.visitors[d]):null, clicks=G?tot(days,d=>G.clicks[d]):null;
  const orders=tot(days,d=>(S[d]||{}).orders), tickets=tot(days,d=>(S[d]||{}).tickets);
  const spend=M?tot(days,d=>M.spend[d]):null, adBuys=M?tot(days,d=>M.purchases[d]):null;

  /* 1. воронка */
  app.append(el('h2',null,'Воронка'));
  const steps=[
    ['Прийшли на сайт',visitors,'людей','Google Analytics'],
    ['Натиснули «Купити квиток»',clicks,'людей','Google Analytics'],
    ['Оплатили',orders,'замовлень · ≈ '+fmt(tickets)+' квитк.','WayForPay']
  ];
  const f=el('div','funnel'), top=Math.max(1,...steps.map(s=>s[1]||0));
  steps.forEach(([label,val,unit,src],i)=>{
    const row=el('div','step');
    const head=el('div','sh');head.append(el('span','sl',label),el('span','ss',src));
    const bar=el('div','track');const fill=el('div','fill');fill.style.width=val==null?'0':Math.max(.6,val/top*100)+'%';bar.append(fill);
    const num=el('div','sv');
    if(val==null){num.append(el('span','muted','не підключено'))}else{num.append(el('b',null,fmt(val)),el('span','muted',' '+unit))}
    row.append(head,bar,num);
    if(i>0){const prev=steps[i-1][1];const conv=el('div','conv',val!=null&&prev?'↓ '+pct(val,prev)+' з попереднього кроку':'');f.append(conv)}
    f.append(row);
  });
  app.append(f);
  if(G&&visitors)app.append(el('p','sub','Від відвідувача до оплати: '+pct(orders,visitors)+'. Google рахує лише тих, хто дав згоду на cookies (поза ЄС — усіх, у ЄС — після «Дивіться»), тож реальних відвідувачів трохи більше.'));
  if(!G)app.append(note(D.ga?'Google Analytics: '+D.ga.error:'Перші два кроки — з Google Analytics, його ще не підключено (docs/DASHBOARD.md).',D.ga?'err':''));
  if(D.wfp&&D.wfp.error)app.append(note('WayForPay: '+D.wfp.error,'err'));

  /* 2. реклама */
  app.append(el('h2',null,'Скільки коштує проданий квиток з реклами Meta'));
  if(M){
    const T=el('div','tiles');
    T.append(tile('Витрачено на рекламу',uah(spend)));
    T.append(tile('Ціна квитка з реклами',adBuys?uah(spend/adBuys):'—',fmt(adBuys)+' покупок, які Meta приписує рекламі'));
    T.append(tile('Витрати на будь-який проданий квиток',tickets?uah(spend/tickets):'—','усі '+fmt(tickets)+' квитк. за період'));
    app.append(T);
  }else app.append(note(D.meta?'Meta: '+D.meta.error:'Рекламу Meta ще не підключено — потрібні META_AD_ACCOUNT_ID і META_ADS_TOKEN (docs/DASHBOARD.md).',D.meta?'err':''));

  /* 3. по днях */
  const det=el('details');det.open=period<=7;det.append(el('summary',null,'По днях'));const tb=el('table');const hr=el('tr');
  ['Дата','Прийшли','«Купити»','Оплатили','Конверсія','Витрати Meta','Ціна квитка з реклами'].forEach(h=>hr.append(el('th',null,h)));tb.append(hr);
  [...days].reverse().forEach(d=>{const r=el('tr');const v=G?G.visitors[d]||0:null,c=G?G.clicks[d]||0:null,o=(S[d]||{}).orders||0,sp=M?M.spend[d]||0:null,ab=M?M.purchases[d]||0:null;
    [d.split('-').reverse().slice(0,2).join('.'),v==null?'—':fmt(v),c==null?'—':fmt(c),fmt(o),v?pct(o,v):'—',sp==null?'—':uah(sp),ab?uah(sp/ab):'—'].forEach(x=>r.append(el('td',null,x)));tb.append(r)});
  det.append(tb);app.append(det);
}
const btns=[...document.querySelectorAll('.seg button')];
btns.forEach(b=>b.addEventListener('click',()=>{btns.forEach(x=>x.setAttribute('aria-pressed',x===b?'true':'false'));render(+b.dataset.p)}));
render(30);
</script></body></html>`;
}

/* ---------- обробник ---------- */
let cache = { at: 0, html: '' };

export async function handle(request, env = process.env) {
  /* відкрито без пароля (рішення власника 06.10.2026); на сторінці немає назви проєкту, пошуковики її не індексують.
     Якщо задано DASHBOARD_PASSWORD — знову питає пароль */
  const pass = env.DASHBOARD_PASSWORD || '';
  if (pass) {
    const h = request.headers.get('authorization') || '';
    const given = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
    if (!(given.length === pass.length && timingSafeEqual(Buffer.from(given), Buffer.from(pass)))) return new Response('Потрібен пароль', { status: 401, headers: { 'www-authenticate': 'Basic realm="dashboard", charset="UTF-8"', 'x-robots-tag': 'noindex' } });
  }

  const fresh = new URL(request.url).searchParams.has('fresh');
  if (!fresh && cache.html && Date.now() - cache.at < 5 * 60 * 1000) return html(cache.html);

  const now = Math.floor(Date.now() / 1000), today = kyivDate(now), from = kyivDate(now - 29 * DAY);
  const data = { updated: new Date(now * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/Kyiv' }).slice(0, 16), today, days: days(from, today), button: BUTTON };
  const tasks = [
    env.WAYFORPAY_SECRET_KEY ? wayforpay(env.WAYFORPAY_SECRET_KEY, now).then(x => { data.wfp = x; }, e => { data.wfp = { error: e.message }; }) : null,
    env.GA4_PROPERTY_ID && env.GA4_SA_JSON ? ga4(env.GA4_PROPERTY_ID, env.GA4_SA_JSON, from).then(x => { data.ga = x; }, e => { data.ga = { error: e.message }; }) : null,
    env.META_AD_ACCOUNT_ID && env.META_ADS_TOKEN ? meta(env.META_AD_ACCOUNT_ID, env.META_ADS_TOKEN, from, today).then(x => { data.meta = x; }, e => { data.meta = { error: e.message }; }) : null
  ];
  await Promise.all(tasks);
  cache = { at: Date.now(), html: page(data) };
  return html(cache.html);
}
const html = s => new Response(s, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' } });

export function GET(request) { return handle(request); }
