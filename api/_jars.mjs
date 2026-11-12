/* Банки збирачів (рішення власника 12.11.2026): вкладка «Банки» дашборда — скільки зібрано в банках Monobank у реальному часі.
   Звідки що:
   - список збирачів і їхніх банок — публічна таблиця Notion «Збирачі та банкіри» (без токена, через публічний API notion.site);
     перечитується не частіше ніж раз на 6 год (JARS_LIST_HOURS) — так просила команда; останній список лежить в Upstash (`vw:jars:list`),
     тож якщо Notion недоступний, дашборд працює зі збереженим;
   - суми й цілі — публічна сторінка банки Monobank (той самий запит, що робить send.monobank.ua у браузері), без ключів;
     опитуються не частіше ніж раз на 30 с, хоч скільки людей дивиться дашборд;
   - історія — щогодинні знімки сум (`vw:jars:hist`: година за Києвом `YYYY-MM-DDTHH` → {банка: гривні} — остання сума години;
     `YYYY-MM-DDTHHf` — перша сума години, щоб приріст усередині години не губився) — з них «сьогодні», «за годину» і графік по днях.
     Знімок пишеться, коли хтось дивиться дашборд, тож за години, коли його ніхто не відкривав, знімка немає (сума все одно точна).
   Змінні: JARS_NOTION_PAGE (адреса таблиці; є типова), Upstash — як у _orders.mjs. Жодних секретів. */
import { randomBytes } from 'node:crypto';
import { store } from './_orders.mjs';

export const NOTION_PAGE = 'https://kozhnatvaryna.notion.site/413ec4daad6d808f85c8e694f87ae7c4';
const LIST_KEY = 'vw:jars:list', HIST_KEY = 'vw:jars:hist';
const kyivHour = (ms = Date.now()) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Kyiv' }).slice(0, 13).replace(' ', 'T'); // YYYY-MM-DDTHH

async function redis(env, args, fetchImpl) {
  const s = store(env); if (!s) return null;
  const j = await (await fetchImpl(s.url, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) })).json();
  if (j.error) throw new Error(`Redis: ${j.error}`);
  return j.result;
}

const uuid = s => { const h = String(s).replace(/-/g, ''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
export const jarId = url => { const m = String(url || '').match(/send\.monobank\.ua\/(?:jar\/)?([A-Za-z0-9]{6,})/); return m ? m[1] : null; };

/* таблиця Notion → [{name, jar}] (збирачі без банки — {name, jar:null}) */
export async function notionList(pageUrl = NOTION_PAGE, fetchImpl = fetch) {
  const u = new URL(pageUrl), base = `${u.origin}/api/v3`, pageId = uuid(u.pathname.match(/[0-9a-f]{32}/i)[0]);
  const post = async (path, body) => { const r = await fetchImpl(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (j.isNotionError || j.errorId) throw new Error(`Notion: ${j.message || j.name}`); return j; };
  const v = x => (x && x.value && x.value.value) || (x && x.value) || x;
  const chunk = await post('loadCachedPageChunkV2', { page: { id: pageId }, limit: 30, cursor: { stack: [] }, verticalColumns: false });
  const blocks = chunk.recordMap.block, page = v(blocks[pageId]), spaceId = page.space_id || blocks[pageId].spaceId;
  const collId = page.collection_id, viewId = (page.view_ids || [])[0];
  const coll = v(chunk.recordMap.collection[collId]), schema = coll.schema;
  const prop = name => Object.keys(schema).find(k => schema[k].name === name);
  const pJar = prop('Банка'), pTitle = 'title';
  const q = await post('queryCollection', { collection: { id: collId, spaceId }, collectionView: { id: viewId, spaceId }, loader: { type: 'reducer', reducers: { collection_group_results: { type: 'results', limit: 1000 } }, searchQuery: '', userTimeZone: 'Europe/Kyiv' } });
  const ids = q.result.reducerResults.collection_group_results.blockIds, rows = q.recordMap.block;
  const text = p => (p || []).map(x => x[0]).join('').trim();
  const out = [];
  for (const id of ids) {
    const b = v(rows[id]); if (!b || !b.properties) continue;
    const name = text(b.properties[pTitle]); if (!name) continue;
    out.push({ name, jar: jarId(text(b.properties[pJar])) });
  }
  return out;
}

/* сума й ціль однієї банки, у гривнях */
export async function monoJar(id, fetchImpl = fetch) {
  const r = await fetchImpl('https://send.monobank.ua/api/handler', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ c: 'hello', clientId: id, referer: '', Pc: randomBytes(32).toString('base64') }) });
  const j = await r.json();
  if (!(typeof j.jarAmount === 'number')) throw new Error(j.errText || j.errCode || `Monobank ${r.status}`);
  return { amount: j.jarAmount / 100, goal: (j.jarGoal || 0) / 100, closed: j.jarStatus === 'CLOSED' };
}

let mem = { list: null, listAt: 0, jars: null, jarsAt: 0, hist: null, histAt: 0, lastSaved: '' };
export const _reset = () => { mem = { list: null, listAt: 0, jars: null, jarsAt: 0, hist: null, histAt: 0, lastSaved: '' }; };

async function list(env, fetchImpl, force) {
  const hours = Number(env.JARS_LIST_HOURS) || 6;
  if (!force && mem.list && Date.now() - mem.listAt < hours * 3600e3) return mem.list;
  let saved = null;
  if (!mem.list) saved = await redis(env, ['GET', LIST_KEY], fetchImpl).then(x => x && JSON.parse(x), () => null);
  if (!force && saved && Date.now() - saved.at < hours * 3600e3) { mem.list = saved; mem.listAt = saved.at; return saved; }
  try {
    const rows = await notionList(env.JARS_NOTION_PAGE || NOTION_PAGE, fetchImpl);
    const fresh = { at: Date.now(), rows };
    mem.list = fresh; mem.listAt = fresh.at;
    await redis(env, ['SET', LIST_KEY, JSON.stringify(fresh)], fetchImpl).catch(() => {});
    return fresh;
  } catch (e) {
    const old = mem.list || saved;
    if (old) { mem.listAt = Date.now() - (hours - 0.25) * 3600e3; return { ...old, error: e.message }; }  // спробувати знову за 15 хв
    throw e;
  }
}

/* усе для вкладки «Банки» */
export async function jars(env = process.env, fetchImpl = fetch, { force = false } = {}) {
  const L = await list(env, fetchImpl, force);
  const fresh = Date.now() - mem.jarsAt < 30e3 && mem.jars && !force;
  if (!fresh) {
    const ids = [...new Set(L.rows.map(r => r.jar).filter(Boolean))];
    const prev = mem.jars || {};
    const got = await Promise.all(ids.map(id => monoJar(id, fetchImpl).then(x => [id, x], e => [id, prev[id] ? { ...prev[id], stale: true } : { error: e.message }])));
    mem.jars = Object.fromEntries(got); mem.jarsAt = Date.now();
  }
  /* історія: читати раз на 5 хв; писати знімок, коли змінились суми або почалась нова година */
  if (!mem.hist || Date.now() - mem.histAt > 5 * 60e3) {
    const flat = await redis(env, ['HGETALL', HIST_KEY], fetchImpl).catch(() => null) || [];
    mem.hist = {}; for (let i = 0; i < flat.length; i += 2) mem.hist[flat[i]] = JSON.parse(flat[i + 1]);
    mem.histAt = Date.now();
  }
  const hour = kyivHour(), now = Object.fromEntries(Object.entries(mem.jars).filter(([, x]) => typeof x.amount === 'number').map(([id, x]) => [id, x.amount]));
  const sig = hour + JSON.stringify(now);
  if (sig !== mem.lastSaved && Object.keys(now).length) {
    if (!mem.hist[hour + 'f']) { mem.hist[hour + 'f'] = mem.hist[hour] || now; await redis(env, ['HSETNX', HIST_KEY, hour + 'f', JSON.stringify(mem.hist[hour + 'f'])], fetchImpl).catch(() => {}); }
    mem.hist[hour] = now; mem.lastSaved = sig;
    await redis(env, ['HSET', HIST_KEY, hour, JSON.stringify(now)], fetchImpl).catch(() => {});
  }
  return {
    updated: new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Kyiv' }).slice(0, 19),
    listUpdated: new Date(L.at).toLocaleString('sv-SE', { timeZone: 'Europe/Kyiv' }).slice(0, 16),
    listError: L.error || null,
    hour,
    people: L.rows.map(r => ({ name: r.name, jar: r.jar, ...(r.jar ? mem.jars[r.jar] || {} : {}) })),
    hist: mem.hist
  };
}
