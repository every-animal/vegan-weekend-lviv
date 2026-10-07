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
  const [visitors, clicks, purchases] = await Promise.all([run({ metrics: [{ name: 'totalUsers' }], dimensionFilter: withStream() }), run(event('begin_checkout')), run({ metrics: [{ name: 'transactions' }], dimensionFilter: withStream() })  /* унікальні номери замовлень: повтори WayForPay не рахуються двічі */]);
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
<meta http-equiv="refresh" content="300"><meta name="theme-color" content="#1c1b1b"><title>Воронка</title>
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
.per{display:flex;gap:6px;margin:18px 0 14px;background:var(--card-2);padding:4px;border-radius:999px;width:max-content}
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
.step:before{content:"";width:2px;height:22px;background:var(--rule)}
.total{margin-top:14px;text-align:center;color:var(--ink-2);font-size:14px}.total b{color:var(--pink)}
/* ads */
.ad{background:var(--card-2);border-radius:20px;padding:20px 20px 18px}
.ad .say{font-size:15px;color:var(--ink-2)}.ad .say b{display:block;font-family:"HN";font-size:clamp(60px,15vw,96px);font-variation-settings:"wght" 900,"wdth" 520;color:var(--pink);line-height:.9;margin:6px 0 4px;text-transform:uppercase}
.trio{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px}
.trio div{background:var(--bg);border-radius:14px;padding:12px}.trio .v{font-family:"HN";font-size:30px;font-variation-settings:"wght" 800,"wdth" 520;margin-top:4px}.trio small{display:block;color:var(--ink-3);font-size:11px;margin-top:4px;line-height:1.3}
.todo{background:var(--card-2);border-radius:20px;padding:18px 20px;color:var(--ink-2)}
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
@media (max-width:520px){.stage .n{font-size:38px}.trio .v{font-size:24px}.trio .cap{font-size:10px}.trio{grid-template-columns:1fr 1fr}.trio div:last-child{grid-column:span 2}h2{font-size:26px}}
</style></head><body><main>
<div class="top"><span class="live"><i></i>live</span><span class="count">до фестивалю <b id="cd"></b> днів</span></div>
<div class="per" role="group" aria-label="Період"><button data-p="1">Сьогодні</button><button data-p="7" aria-pressed="true">7 днів</button><button data-p="30">30 днів</button></div>
<div id="app"></div>
<details><summary>Як рахується</summary><dl class="how">
<dt>Прийшли на сайт</dt><dd>Унікальні відвідувачі сайту за період (Google Analytics, лише потік цього сайту). Рахуються лише ті, хто дав згоду на cookies: поза ЄС — усі, у ЄС — після «Дивіться» в банері. Люди з блокувальниками реклами сюди не потрапляють — реальних відвідувачів трохи більше.</dd>
<dt>Натиснули «Купити квиток»</dt><dd>Кліки на будь-яку кнопку купівлі на сайті (подія <code>begin_checkout</code>). Дві спроби однієї людини — два кліки. Ті самі правила згоди, що й для відвідувачів.</dd>
<dt>Оплатили</dt><dd>Унікальні успішні замовлення на WayForPay. Після кожної оплати WayForPay повідомляє наш сервер, а той передає покупку в Google — тому оплати рахуються всі, навіть без згоди на cookies, і повторні повідомлення не задвоюються. Одне замовлення може містити кілька квитків. Дані — з 06.10.2026.</dd>
<dt>% між кроками</dt><dd>Скільки дійшло до кроку від попереднього. Оплати рахуються за всіма покупцями, а кліки — лише за тими, хто дав згоду, тож «оплатили з кліків» буває завищеним, а іноді й понад 100%. Ширина блоків воронки — наочна, не в масштабі; точні числа — на блоках.</dd>
<dt>Порівняння з попереднім періодом</dt><dd>«Сьогодні» — з учора; «7 днів» — з попередніми 7 днями; «30 днів» — з попередніми 30.</dd>
<dt>Реклама Meta</dt><dd><b>Квиток з реклами</b> — витрачено / покупки, які Meta зарахувала рекламі (людина клікнула рекламу до 7 днів або побачила її до 1 дня перед покупкою — стандартне налаштування кабінету). <b>На будь-який квиток</b> — витрачено / усі оплати: скільки реклама коштує в перерахунку на кожен проданий квиток, звідки б покупець не прийшов.</dd>
<dt>Дні й оновлення</dt><dd>Дні — за київським часом. Сторінка оновлюється сама кожні 5 хв. Google домальовує дані до 24–48 год, тож цифри за сьогодні й учора можуть ще трохи зрости.</dd>
</dl></details>
<p class="foot">Оновлено ${esc(data.updated)} (Київ)</p>
</main>
<script>
const D=${JSON.stringify(data).replace(/</g, '\\u003c')};
const fmt=n=>Math.round(n).toLocaleString('uk-UA'), pct=(a,b)=>b?(a/b*100).toFixed(a/b<.1?1:0)+'%':'—';
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e};
const app=document.getElementById('app'), reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const G=D.ga&&!D.ga.error?D.ga:null, M=D.meta&&!D.meta.error?D.meta:null;
const sum=(ds,o)=>ds.reduce((a,d)=>a+((o||{})[d]||0),0);
const plural=(n,a,b,c)=>{n=Math.abs(n)%100;const m=n%10;return n>10&&n<20?c:m===1?a:m>=2&&m<=4?b:c};
document.getElementById('cd').textContent=Math.max(0,Math.ceil((Date.parse('2026-11-22T11:00:00Z')-Date.now())/864e5));
/* numbers count up once */
function count(node,to,suffix){suffix=suffix||'';if(reduce||!to){node.textContent=fmt(to)+suffix;return}const t0=performance.now(),dur=700;const f=t=>{const k=Math.min(1,(t-t0)/dur),e=1-Math.pow(1-k,3);node.textContent=fmt(to*e)+suffix;if(k<1)requestAnimationFrame(f)};requestAnimationFrame(f)}
let first=true;
function render(p){
  app.replaceChildren();app.classList.toggle('anim',first&&!reduce);
  const ds=D.days.slice(-p), prev=D.days.slice(-2*p,-p);
  const v=G?sum(ds,G.visitors):0,c=G?sum(ds,G.clicks):0,b=G?sum(ds,G.purchases):0,bp=G?sum(prev,G.purchases):0;
  const label=p===1?'сьогодні':'за '+p+' днів', prevLabel=p===1?'учора':'за попередні '+p+' днів';

  /* hero */
  const h=el('section','hero');h.append(el('div','cap','Оплатили '+label));
  const big=el('div','hn big');h.append(big);
  const row=el('div','row');
  if(G){const d=b-bp;const ch=el('span','chip'+(d>0?' up':''),d>0?'↑ на '+d+' більше, ніж '+prevLabel:d<0?'↓ на '+Math.abs(d)+' менше, ніж '+prevLabel:'стільки ж, як '+prevLabel);row.append(ch);
    row.append(el('span',null,v?pct(b,v)+' відвідувачів дійшли до оплати':'відвідувачів ще немає'))}
  else row.append(el('span',null,D.ga?'Google: '+D.ga.error:'Google Analytics ще не підключено'));
  h.append(row);app.append(h);count(big,b);

  /* funnel */
  const t=el('h2');t.append(document.createTextNode('Шлях до '),el('i',null,'квитка'));app.append(t);
  const f=el('div','fun');const top=Math.max(1,v);
  const st=[['s1','Прийшли на сайт',v],['s2','Натиснули «Купити квиток»',c],['s3','Оплатили',b]];
  st.forEach(([cls,l,n],i)=>{
    if(i){const s=el('div','step');s.append(el('b',null,pct(n,st[i-1][2])),document.createTextNode(i===1?' натиснули «Купити»':' оплатили'));f.append(s)}
    const g=el('div','stage '+cls);g.style.setProperty('--w',(34+66*Math.sqrt(n/top))+'%');
    const nn=el('div','hn n');g.append(el('div','l',l),nn);f.append(g);count(nn,n)});
  app.append(f);

  /* ads */
  const a=el('h2');a.append(document.createTextNode('Реклама '),el('i',null,'Meta'));app.append(a);
  if(M){const sp=sum(ds,M.spend),mb=sum(ds,M.purchases);
    const box=el('section','ad');const say=el('div','say');say.append(document.createTextNode('Квиток з реклами коштує'),el('b',null,mb?fmt(sp/mb)+' грн':'—'),document.createTextNode(mb?'':' — реклама ще не принесла покупок за цей період'));box.append(say);
    const tr=el('div','trio');[['Витрачено',fmt(sp)+' грн',''],['Покупок з реклами',fmt(mb),'за даними Meta'],['На будь-який квиток',b?fmt(sp/b)+' грн':'—','витрачено / усі оплати']].forEach(([l,val,n])=>{const d=el('div');d.append(el('div','cap',l),el('div','v',val));if(n)d.append(el('small',null,n));tr.append(d)});
    box.append(tr);app.append(box)}
  else{const td=el('div','todo');td.append(el('b',null,D.meta?'Meta: '+D.meta.error:'Ще не підключено.'),document.createTextNode(D.meta?'':' Тут зʼявиться, скільки коштує квиток з реклами.'));app.append(td)}

  /* days */
  if(G){
    const n=p===1?14:p, days=D.days.slice(-n);
    const dh=el('h2');dh.append(document.createTextNode('По '),el('i',null,'днях'));app.append(dh);
    const ch=el('section','chart');const bars=el('div','bars');const max=Math.max(1,...days.map(d=>G.purchases[d]||0));
    const best=days.reduce((a,d)=>(G.purchases[d]||0)>(G.purchases[a]||0)?d:a,days[0]);
    const read=el('div','read');
    const show=d=>{read.replaceChildren();const dd=el('span','d');dd.append(el('b',null,d.slice(8)+'.'+d.slice(5,7)));read.append(dd);
      [['оплат',G.purchases[d]],['кліків «Купити»',G.clicks[d]],['відвідувачів',G.visitors[d]]].concat(M?[['грн на рекламу',M.spend[d]]]:[]).forEach(([l,x])=>{const s=el('span');s.append(el('b',null,fmt(x||0)),document.createTextNode(' '+l));read.append(s)});
      bars.querySelectorAll('button').forEach(x=>x.setAttribute('aria-current',x.dataset.d===d?'true':'false'))};
    days.forEach((d,i)=>{const x=G.purchases[d]||0;const btn=el('button');btn.dataset.d=d;btn.setAttribute('aria-label',d+': '+x+' оплат');
      const bar=el('div','b'+(x?'':' zero'));bar.style.height=(x/max*100)+'%';bar.style.setProperty('--i',i);btn.append(bar);
      if(d===best&&(G.purchases[d]||0)>0){const tag=el('span','best','рекорд');tag.style.setProperty('--h',(x/max*100)+'%');btn.append(tag)}
      btn.addEventListener('pointerenter',()=>show(d));btn.addEventListener('focus',()=>show(d));btn.addEventListener('click',()=>show(d));bars.append(btn)});
    ch.append(bars);const ax=el('div','axis');ax.append(el('span',null,days[0].slice(8)+'.'+days[0].slice(5,7)),el('span',null,'сьогодні'));ch.append(ax,read);app.append(ch);show(days[days.length-1]);
  }
  if(D.ga&&D.ga.error)app.append(el('div','err','Google: '+D.ga.error));
  first=false;
}
const btns=[...document.querySelectorAll('.per button')];
btns.forEach(x=>x.addEventListener('click',()=>{btns.forEach(y=>y.setAttribute('aria-pressed',y===x?'true':'false'));render(+x.dataset.p)}));
render(7);
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

  const now = Math.floor(Date.now() / 1000), today = kyivDate(now), from = kyivDate(now - 59 * DAY);  // 60 днів: період + попередній такий самий для порівняння
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
