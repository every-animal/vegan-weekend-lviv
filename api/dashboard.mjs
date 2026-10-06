/* Дашборд продажів (рішення власника 06.10.2026): https://www.veganweekend.org/api/dashboard — за паролем.
   Три питання, щодня: скільки квитків продано і на яку суму; скільки людей прийшло і скільки натиснули «Купити»;
   скільки коштує проданий квиток з реклами Meta. Дані тягнуться на сервері, ключі в браузер не потрапляють.

   Змінні середовища (Vercel, Production):
   DASHBOARD_PASSWORD                 — пароль (логін будь-який)
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
    if (Number(j.reasonCode) !== 1100) throw new Error(`WayForPay: ${j.reason || r.status}`);
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
<title>Продажі — Веган Вікенд Львів</title>
<style>
:root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f2f1ee;--text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#7a7974;--grid:#e4e3df;--series-1:#2a78d6;--critical:#c4312f}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--surface-1:#1a1a19;--surface-2:#242423;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#8f8e86;--grid:#33332f;--series-1:#3987e5;--critical:#e66767}}
*{box-sizing:border-box}body{margin:0;background:var(--surface-1);color:var(--text-primary);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 48px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:32px 0 12px}
.sub{color:var(--text-secondary);margin:0 0 20px;font-size:13px}
.hero{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.hero b{font-size:56px;font-weight:600;line-height:1}.hero span{color:var(--text-secondary)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:16px}
.tile{background:var(--surface-2);border-radius:10px;padding:14px 16px}.tile .l{color:var(--text-secondary);font-size:13px}.tile .v{font-size:26px;font-weight:600;margin-top:2px}.tile .n{color:var(--text-muted);font-size:12px;margin-top:2px}
.off{background:var(--surface-2);border-radius:10px;padding:14px 16px;color:var(--text-secondary);font-size:14px}.err{color:var(--critical)}
.chart{position:relative;margin-top:8px}svg{display:block;width:100%;height:auto;overflow:visible}
.tip{position:absolute;pointer-events:none;background:var(--surface-1);border:1px solid var(--grid);border-radius:8px;padding:6px 10px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.12);display:none;white-space:nowrap}.tip b{font-size:15px}
table{border-collapse:collapse;width:100%;font-size:13px;margin-top:8px;font-variant-numeric:tabular-nums}th,td{text-align:right;padding:5px 8px;border-bottom:1px solid var(--grid)}th:first-child,td:first-child{text-align:left}th{color:var(--text-secondary);font-weight:500}
details{margin-top:12px}summary{cursor:pointer;color:var(--text-secondary);font-size:13px}
</style></head><body><main>
<h1>Веган Вікенд Львів — продажі</h1>
<p class="sub">Оновлено ${esc(data.updated)} (Київ). Квитки — з WayForPay, кнопка «vegan_weekend_lviv»; кількість квитків порахована з суми (500 грн до 06.10, 600 грн з 07.10).</p>
<div id="app"></div>
</main>
<script>
const D=${JSON.stringify(data).replace(/</g, '\\u003c')};
const fmt=n=>Math.round(n).toLocaleString('uk-UA'), uah=n=>fmt(n)+' грн';
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e};
const app=document.getElementById('app');
const sum=(o,k)=>Object.values(o||{}).reduce((a,x)=>a+(k?x[k]:x),0);
const today=D.today, last7=D.days.slice(-7);
const S=D.wfp&&D.wfp.sales||{};
const tile=(l,v,n)=>{const t=el('div','tile');t.append(el('div','l',l),el('div','v',v));if(n)t.append(el('div','n',n));return t};
const off=(txt,cls)=>el('div','off'+(cls?' '+cls:''),txt);

/* 1. продажі */
if(D.wfp&&!D.wfp.error){
  const h=el('div','hero');h.append(el('b',null,fmt(sum(S,'tickets'))),el('span',null,'квитків продано · '+uah(sum(S,'amount'))+' · '+fmt(sum(S,'orders'))+' замовлень'));app.append(h);
  const T=el('div','tiles');
  T.append(tile('Сьогодні',fmt((S[today]||{}).tickets||0)+' квитк.',uah((S[today]||{}).amount||0)));
  T.append(tile('Останні 7 днів',fmt(last7.reduce((a,d)=>a+((S[d]||{}).tickets||0),0))+' квитк.',uah(last7.reduce((a,d)=>a+((S[d]||{}).amount||0),0))));
  T.append(tile('Середній чек',uah(sum(S,'orders')?sum(S,'amount')/sum(S,'orders'):0)));
  app.append(T);
  app.append(el('h2',null,'Квитки по днях'));
  bars(D.days,d=>(S[d]||{}).tickets||0,d=>[fmt((S[d]||{}).tickets||0)+' квитк.',uah((S[d]||{}).amount||0)+' · '+fmt((S[d]||{}).orders||0)+' замовл.']);
}else app.append(off(D.wfp?'Продажі: '+D.wfp.error:'Продажі не підключено','err'));

/* 2. сайт → «Купити» */
app.append(el('h2',null,'Сайт: відвідувачі → кліки «Купити квиток»'));
if(D.ga&&!D.ga.error){
  const v=sum(D.ga.visitors),c=sum(D.ga.clicks),o=sum(S,'orders');
  const T=el('div','tiles');
  T.append(tile('Відвідувачів (30 днів)',fmt(v)),tile('Кліків «Купити»',fmt(c),v?(c/v*100).toFixed(1)+'% відвідувачів':''),tile('Оплат',fmt(o),c?(o/c*100).toFixed(0)+'% від кліків':''));
  app.append(T);
  app.append(el('div','sub','Відвідувачі по днях'));
  bars(D.days,d=>D.ga.visitors[d]||0,d=>[fmt(D.ga.visitors[d]||0)+' відвідувачів',fmt(D.ga.clicks[d]||0)+' кліків «Купити»']);
  app.append(el('p','sub','Google рахує лише тих, хто дав згоду на cookies (поза ЄС — усіх; у ЄС — після «Дивіться»).'));
}else app.append(off(D.ga?'Google Analytics: '+D.ga.error:'Google Analytics ще не підключено — потрібні GA4_PROPERTY_ID і GA4_SA_JSON (docs/DASHBOARD.md).',D.ga?'err':''));

/* 3. реклама Meta */
app.append(el('h2',null,'Реклама Meta: скільки коштує квиток'));
if(D.meta&&!D.meta.error){
  const sp=sum(D.meta.spend),mp=sum(D.meta.purchases),t=sum(S,'tickets');
  const T=el('div','tiles');
  T.append(tile('Витрачено (30 днів)',uah(sp)),tile('Покупок з реклами',fmt(mp),'за даними Meta'),tile('Ціна покупки з реклами',mp?uah(sp/mp):'—'),tile('Витрати на 1 проданий квиток',t?uah(sp/t):'—','усі квитки, не лише з реклами'));
  app.append(T);
  app.append(el('div','sub','Витрати на рекламу по днях, грн'));
  bars(D.days,d=>D.meta.spend[d]||0,d=>[uah(D.meta.spend[d]||0)+' витрачено',fmt(D.meta.purchases[d]||0)+' покупок з реклами']);
}else app.append(off(D.meta?'Meta: '+D.meta.error:'Рекламу Meta ще не підключено — потрібні META_AD_ACCOUNT_ID і META_ADS_TOKEN (docs/DASHBOARD.md).',D.meta?'err':''));

/* таблиця — ті самі дані без графіків */
const det=el('details');det.append(el('summary',null,'Таблиця по днях'));const tb=el('table');const hr=el('tr');
['Дата','Квитки','Сума','Відвідувачі','Кліки «Купити»','Витрати Meta'].forEach(h=>hr.append(el('th',null,h)));tb.append(hr);
[...D.days].reverse().forEach(d=>{const r=el('tr');[d.split('-').reverse().slice(0,2).join('.'),fmt((S[d]||{}).tickets||0),uah((S[d]||{}).amount||0),D.ga&&!D.ga.error?fmt(D.ga.visitors[d]||0):'—',D.ga&&!D.ga.error?fmt(D.ga.clicks[d]||0):'—',D.meta&&!D.meta.error?uah(D.meta.spend[d]||0):'—'].forEach(x=>r.append(el('td',null,x)));tb.append(r)});
det.append(tb);app.append(det);
if(D.wfp&&D.wfp.buttons){const p=el('p','sub','Кнопки WayForPay за період (успішні оплати): '+Object.entries(D.wfp.buttons).map(([k,v])=>k+(k===D.button?' (Львів)':'')+': '+v).join(', '));app.append(p)}

/* стовпчики: одна серія, 4px округлення, 2px проміжок, підказка на наведенні й фокусі */
function bars(days,val,tip){
  const W=Math.max(300,app.clientWidth),H=W<600?160:200,P=28,n=days.length,max=Math.max(1,...days.map(val)),bw=(W-P)/n;
  const ns='http://www.w3.org/2000/svg',box=el('div','chart'),svg=document.createElementNS(ns,'svg'),tt=el('div','tip');
  svg.setAttribute('viewBox','0 0 '+W+' '+(H+22));svg.setAttribute('role','img');svg.setAttribute('aria-label','Графік по днях; ті самі дані — у таблиці нижче');
  const ticks=[0,max/2,max].map(Math.round);
  ticks.forEach(t=>{const y=H-t/max*H;const l=document.createElementNS(ns,'line');l.setAttribute('x1',P);l.setAttribute('x2',W);l.setAttribute('y1',y);l.setAttribute('y2',y);l.setAttribute('stroke','var(--grid)');svg.append(l);const tx=document.createElementNS(ns,'text');tx.setAttribute('x',P-6);tx.setAttribute('y',y+4);tx.setAttribute('text-anchor','end');tx.setAttribute('font-size','11');tx.setAttribute('fill','var(--text-muted)');tx.textContent=fmt(t);svg.append(tx)});
  days.forEach((d,i)=>{const v=val(d),h=v/max*H,x=P+i*bw;
    const g=document.createElementNS(ns,'g');g.setAttribute('tabindex','0');
    const hit=document.createElementNS(ns,'rect');hit.setAttribute('x',x);hit.setAttribute('y',0);hit.setAttribute('width',bw);hit.setAttribute('height',H);hit.setAttribute('fill','transparent');g.append(hit);
    if(v>0){const r=document.createElementNS(ns,'path'),w=Math.max(1,bw-2),rr=Math.min(4,w/2,h);r.setAttribute('d','M'+(x+1)+','+H+'v'+(-(h-rr))+'q0,'+(-rr)+' '+rr+','+(-rr)+'h'+(w-2*rr)+'q'+rr+',0 '+rr+','+rr+'v'+(h-rr)+'z');r.setAttribute('fill','var(--series-1)');g.append(r)}
    if(i%Math.ceil(n/(W<600?4:8))===0||i===n-1){const tx=document.createElementNS(ns,'text');tx.setAttribute('x',x+bw/2);tx.setAttribute('y',H+16);tx.setAttribute('text-anchor','middle');tx.setAttribute('font-size','11');tx.setAttribute('fill','var(--text-muted)');tx.textContent=d.slice(8)+'.'+d.slice(5,7);svg.append(tx)}
    const show=()=>{tt.replaceChildren();const[a,b]=tip(d);tt.append(el('b',null,a),el('div',null,b),el('div','n',d.split('-').reverse().join('.')));tt.style.display='block';const bx=box.getBoundingClientRect(),gx=g.getBoundingClientRect();tt.style.left=Math.min(bx.width-tt.offsetWidth,Math.max(0,gx.left-bx.left+gx.width/2-tt.offsetWidth/2))+'px';tt.style.top='-8px';g.style.opacity='.8'};
    const hide=()=>{tt.style.display='none';g.style.opacity=''};
    g.addEventListener('pointerenter',show);g.addEventListener('focus',show);g.addEventListener('pointerleave',hide);g.addEventListener('blur',hide);svg.append(g)});
  box.append(svg,tt);app.append(box);
}
</script></body></html>`;
}

/* ---------- обробник ---------- */
let cache = { at: 0, html: '' };

export async function handle(request, env = process.env) {
  const pass = env.DASHBOARD_PASSWORD || '';
  const h = request.headers.get('authorization') || '';
  const given = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
  const ok = pass && given.length === pass.length && timingSafeEqual(Buffer.from(given), Buffer.from(pass));
  if (!ok) return new Response('Потрібен пароль', { status: 401, headers: { 'www-authenticate': 'Basic realm="Veganweekend dashboard", charset="UTF-8"', 'x-robots-tag': 'noindex' } });

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
