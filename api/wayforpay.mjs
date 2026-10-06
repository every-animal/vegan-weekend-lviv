/* WayForPay → Meta Conversions API (+ GA4), замість сценарію Make «Integration Webhooks» (рішення власника 06.10.2026).

   WayForPay шле сюди результат кожної оплати (serviceUrl). Обробник:
   1. читає тіло як є (WayForPay шле JSON, але з Content-Type форми — Make через це ламався);
   2. перевіряє підпис merchantSignature секретним ключем мерчанта — підробку відкидає;
   3. для успішної оплати квитка (Approved, orderReference «WFP-SOC-…» — той самий фільтр, що в Make)
      шле Purchase у Meta Conversions API (event_id = orderReference, тож повтори не задвоюються)
      і, якщо задано GA4_API_SECRET, — purchase у Google Analytics (Measurement Protocol);
   4. відповідає WayForPay підписаним «accept». Якщо Meta не прийняла подію — відповідає 502,
      і WayForPay повторить запит пізніше.

   Секрети — лише в змінних середовища Vercel (репозиторій публічний):
   WAYFORPAY_SECRET_KEY, META_CAPI_TOKEN, необовʼязково GA4_API_SECRET і META_TEST_EVENT_CODE. */
import { createHmac, createHash } from 'node:crypto';

const PIXEL_ID = '1647718446547735';
const GA4_ID = 'G-4PKFB5CKBV';
const GRAPH = 'https://graph.facebook.com/v21.0';
const SITE = 'https://www.veganweekend.org/';

const hmacMd5 = (key, s) => createHmac('md5', key).update(s, 'utf8').digest('hex');
const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex');

/* WayForPay кладе JSON у тіло з Content-Type application/x-www-form-urlencoded — тож тіло може бути
   або чистим JSON, або JSON, закодованим як форма (ключ без значення). Пробуємо обидва. */
export function parseBody(raw) {
  const s = (raw || '').trim();
  try { return JSON.parse(s); } catch (e) {}
  try { return JSON.parse(decodeURIComponent(s.replace(/\+/g, ' ')).replace(/=$/, '')); } catch (e) {}
  try { const k = [...new URLSearchParams(s).keys()][0]; if (k) return JSON.parse(k); } catch (e) {}
  return null;
}

export function validSignature(p, secret) {
  const s = [p.merchantAccount, p.orderReference, p.amount, p.currency, p.authCode, p.cardPan, p.transactionStatus, p.reasonCode].join(';');
  const sig = String(p.merchantSignature || '');
  return sig.length === 32 && hmacMd5(secret, s) === sig.toLowerCase();
}

export function acceptResponse(orderReference, secret, now = Math.floor(Date.now() / 1000)) {
  return { orderReference, status: 'accept', time: now, signature: hmacMd5(secret, `${orderReference};accept;${now}`) };
}

export const isTicketPurchase = p => p.transactionStatus === 'Approved' && String(p.orderReference || '').includes('WFP-SOC-');

/* Подія Purchase для Meta. Особисті дані — лише хешем SHA-256, як вимагає Meta. */
export function metaEvent(p) {
  const em = String(p.email || '').trim().toLowerCase();
  const ph = String(p.phone || '').replace(/\D/g, '');
  const names = String(p.clientName || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const products = Array.isArray(p.products) ? p.products : [];
  const user_data = {};
  if (em) user_data.em = [sha256(em)];
  if (ph) user_data.ph = [sha256(ph)];
  if (names.length >= 2) { user_data.fn = [sha256(names[0])]; user_data.ln = [sha256(names[names.length - 1])]; }
  const t = Number(p.processingDate) || Number(p.createdDate);
  return {
    event_name: 'Purchase',
    event_id: p.orderReference,
    event_time: t && t > Date.now() / 1000 - 6 * 86400 ? t : Math.floor(Date.now() / 1000),
    action_source: 'website',
    event_source_url: SITE,
    user_data,
    custom_data: {
      currency: p.currency || 'UAH',
      value: Number(p.amount) || 0,
      order_id: p.orderReference,
      num_items: products.reduce((a, x) => a + (Number(x.count) || 1), 0) || undefined,
      contents: products.length ? products.map(x => ({ id: String(x.name || 'ticket'), quantity: Number(x.count) || 1, item_price: Number(x.price) || undefined })) : undefined,
      content_type: 'product'
    }
  };
}

export function gaPurchase(p) {
  const products = Array.isArray(p.products) ? p.products : [];
  return {
    client_id: `wfp.${String(p.orderReference).replace(/\D/g, '').slice(-10) || Date.now()}`,
    non_personalized_ads: false,
    events: [{ name: 'purchase', params: {
      transaction_id: p.orderReference, currency: p.currency || 'UAH', value: Number(p.amount) || 0,
      items: products.map(x => ({ item_name: String(x.name || 'ticket'), price: Number(x.price) || 0, quantity: Number(x.count) || 1 }))
    } }]
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export async function handle(request, env = process.env, fetchImpl = fetch) {
  const secret = env.WAYFORPAY_SECRET_KEY;
  if (!secret || !env.META_CAPI_TOKEN) { console.error('wayforpay: env not configured'); return json({ error: 'not configured' }, 500); }

  const p = parseBody(await request.text());
  if (!p || !p.orderReference) { console.warn('wayforpay: unreadable body'); return json({ error: 'bad request' }, 400); }
  if (!validSignature(p, secret)) { console.warn('wayforpay: bad signature', p.orderReference); return json({ error: 'bad signature' }, 403); }

  if (isTicketPurchase(p)) {
    const body = { data: [metaEvent(p)] };
    if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;
    const r = await fetchImpl(`${GRAPH}/${PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).catch(e => ({ ok: false, status: 0, text: async () => String(e) }));
    if (!r.ok) {
      console.error('wayforpay: meta rejected', p.orderReference, r.status, (await r.text()).slice(0, 300));
      return json({ error: 'meta failed' }, 502);   // WayForPay повторить запит
    }
    if (env.GA4_API_SECRET) {
      await fetchImpl(`https://www.google-analytics.com/mp/collect?measurement_id=${GA4_ID}&api_secret=${encodeURIComponent(env.GA4_API_SECRET)}`, {
        method: 'POST', body: JSON.stringify(gaPurchase(p))
      }).catch(e => console.error('wayforpay: ga4 failed', p.orderReference, String(e)));
    }
    console.log('wayforpay: purchase sent', p.orderReference, p.amount, p.currency);
  } else {
    console.log('wayforpay: skipped', p.orderReference, p.transactionStatus);
  }
  return json(acceptResponse(p.orderReference, secret));
}

export function POST(request) { return handle(request); }
