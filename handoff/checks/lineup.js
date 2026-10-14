// Перевірки секції «Лайнап» (варіант 04 «По одному»; з 14.10.2026 імена змінюються самі, за часом, а не від скролу — рішення власника).
// Запуск: node handoff/checks/lineup.js http://localhost:8080/
// Секція шукається за [data-lu], класами .lu-track, .lu-pin, .lu-svg, .lu-pl.
const { chromium } = require('playwright');
const URL = process.argv[2];
if (!URL) { console.log('usage: node handoff/checks/lineup.js <url of the page>'); process.exit(2); }
const NAMES = ['ЗЛИПНІ', 'LIPATOVA', 'СЕРВАНТ', 'ОНІСУКА ТАЙГЕР', 'OLES dj', 'BOH dj'];
const TICKET = 'https://secure.wayforpay.com/payment/vegan_weekend_lviv';
let n = 0, failed = 0;
const ok = (name, cond, detail) => { n++; if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); };

/* what the section shows right now: the name in the visible layout, the marked button, the width axis of its lines */
const state = p => p.evaluate(() => {
  const svg = [...document.querySelectorAll('.lu-svg')].find(s => getComputedStyle(s).display !== 'none');
  const ts = [...svg.querySelectorAll('defs text')].filter(t => t.textContent);
  const cur = [...document.querySelectorAll('.lu-pl button[aria-current="true"]')];
  const ink = svg.querySelector('.lu-f').getBoundingClientRect();
  return {
    name: ts.map(t => t.textContent).join(' '), lines: ts.length, layout: svg.classList.contains('lu-m') ? 'm' : 'd',
    wdth: ts.map(t => +((t.style.fontVariationSettings.match(/wdth'?"?\s*([\d.]+)/) || [])[1] || 0)),
    target: ts.map(t => { const d = JSON.parse(svg.getAttribute('data-names')); const i = d.findIndex(l => l.map(x => x[0]).join(' ') === ts.map(x => x.textContent).join(' ')); const k = [...svg.querySelectorAll('defs text')].indexOf(t); return i < 0 ? -1 : d[i][k][1]; }),
    cur: cur.map(b => +b.dataset.n),
    ink: [Math.round(ink.left), Math.round(ink.right), Math.round(ink.top), Math.round(ink.bottom)], vw: innerWidth
  };
});
/* the section on screen (its name part under the navbar) / far away */
const toLineup = p => p.evaluate(() => window.scrollTo({ top: document.querySelector('.lu-pin').getBoundingClientRect().top + scrollY - 56, behavior: 'instant' }));
const away = p => p.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
/* record every name shown from now on */
const watch = p => p.evaluate(() => { window.__luSeen = []; const svg = [...document.querySelectorAll('.lu-svg')].find(s => getComputedStyle(s).display !== 'none'); const t0 = svg.querySelector('defs text'); window.__luSeen.push(t0.textContent); new MutationObserver(() => { const t = t0.textContent; if (window.__luSeen[window.__luSeen.length - 1] !== t) window.__luSeen.push(t); }).observe(svg, { subtree: true, childList: true, characterData: true }); });
const seenNames = p => p.evaluate(() => window.__luSeen);
/* show name i from the list and let the change finish (the cycle is far shorter than the wait for the next one) */
const pick = async (p, i) => { await p.click(`.lu-pl button[data-n="${i}"]`); await p.waitForTimeout(1100); };
const open = async (b, w, h, reduce) => {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, reducedMotion: reduce ? 'reduce' : 'no-preference' });
  await ctx.addInitScript(() => { try { localStorage.setItem('vw-cookies', 'no'); } catch (e) {} });   // the cookie card would come on the first scroll and cover the list
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(1500);
  await p.evaluate(() => { const c = document.querySelector('.cbn'); if (c) c.hidden = true; });   // the cookie card stands in the corner
  await p.evaluate(() => document.fonts.ready);
  return { p, ctx, errs };
};

(async () => {
  const b = await chromium.launch({ args: ['--no-proxy-server'] });
  try {
    /* ---------------- desktop 1280 × 720 */
    let { p, ctx, errs } = await open(b, 1280, 720);
    ok('the section stands right after «Що буде» and before «Про збір»', await p.evaluate(() => { const s = document.querySelector('[data-lu]'); return !!s && s.previousElementSibling && s.previousElementSibling.id === 'zones' && s.nextElementSibling && s.nextElementSibling.id === 'fund'; }));
    ok('«Сцена» points to the lineup, «Що буде» no longer promises it', await p.evaluate(() => { const t = document.body.textContent; return t.includes('Лайнап уже є') && !t.includes('Лайнап оголосимо') && !t.includes('програми та лайнап'); }));
    ok('ticket links: 8, all to WayForPay', await p.evaluate(t => [...document.querySelectorAll('a')].filter(a => a.href === t).length === 8, TICKET));
    ok('the list has the six names in order, as buttons', await p.evaluate(N => [...document.querySelectorAll('.lu-pl button')].map(b => b.textContent.replace(/^\d\d/, '')).join('|') === N.join('|'), NAMES));
    ok('the section is one screen tall — no scroll-through, nothing sticky', await p.evaluate(() => { const t = document.querySelector('.lu-track'), pin = document.querySelector('.lu-pin'); return Math.abs(pin.offsetHeight - (innerHeight - 56)) <= 1 && t.offsetHeight === pin.offsetHeight && getComputedStyle(pin).position !== 'sticky'; }));
    /* off screen the names stand still */
    await away(p); await watch(p); await p.waitForTimeout(3500);
    ok('off screen the names stand still', (await seenNames(p)).length === 1, await seenNames(p));
    /* on screen they follow one another by themselves, in order, one at a time */
    await toLineup(p); await watch(p); await p.waitForTimeout(7600);
    const auto = await seenNames(p);
    ok('on screen the names change by themselves, in order, one at a time', auto.length >= 3 && auto.every((x, i) => i === 0 || NAMES.indexOf(x) === (NAMES.indexOf(auto[i - 1]) + 1) % 6), auto);
    const sa = await state(p);
    ok('only the shown name\'s button is marked', sa.cur.length === 1 && NAMES[sa.cur[0]] === sa.name, sa);
    const seen = [];
    for (let i = 0; i < 6; i++) { await pick(p, i); seen.push(await state(p)); }
    ok('desktop: every name in one line, at its fitted width', seen.every((s, i) => s.name === NAMES[i] && s.lines === 1 && s.layout === 'd' && Math.abs(s.wdth[0] - s.target[0]) < 0.2), seen.map(s => [s.name, s.wdth, s.target]));
    ok('desktop: the lettering stays inside the screen', seen.every(s => s.ink[0] >= 0 && s.ink[1] <= s.vw), seen.map(s => s.ink));
    /* the change: squeeze first, then grow back with a spring */
    await pick(p, 2);
    await p.click('.lu-pl button[data-n="3"]');
    const tr = [];
    for (const w of [120, 180, 300, 700]) { await p.waitForTimeout(w); tr.push(await state(p)); }   // at 0.12, 0.3, 0.6 and 1.3 s
    ok('a change squeezes the shown name, swaps it and grows the next one to its width', tr[0].name === NAMES[2] && tr[0].wdth[0] < tr[0].target[0] - 20 && tr[2].name === NAMES[3] && Math.abs(tr[3].wdth[0] - tr[3].target[0]) < 0.2, tr.map(s => [s.name, s.wdth[0], s.target[0]]));
    /* a name from the list: straight to it, then the cycle goes on from it (after the last comes the first) */
    await pick(p, 0); await watch(p);
    await p.click('.lu-pl button[data-n="5"]'); await p.waitForTimeout(1100);
    const sj = await state(p), js = await seenNames(p);
    ok('a name in the list changes straight to it', sj.name === NAMES[5] && sj.cur[0] === 5 && js.join('|') === [NAMES[0], NAMES[5]].join('|'), { seen: js, now: sj.name });
    await p.waitForTimeout(2600);
    ok('after a name from the list the cycle goes on from it, the first after the last', (await state(p)).name === NAMES[0], (await state(p)).name);
    await p.keyboard.press('Shift');
    await p.focus('.lu-pl button[data-n="2"]'); await p.keyboard.press('Enter'); await p.waitForTimeout(1100);
    ok('the list works from the keyboard', (await state(p)).name === NAMES[2]);
    ok('desktop: no console errors', errs.length === 0, errs.join(' | '));
    await ctx.close();

    /* ---------------- phone 390 × 844 */
    ({ p, ctx, errs } = await open(b, 390, 844));
    await toLineup(p); await p.waitForTimeout(300);
    const sm = [];
    for (let i = 0; i < 6; i++) { await pick(p, i); sm.push(await state(p)); }
    ok('phone: every name can be shown', sm.every((s, i) => s.name === NAMES[i] && s.cur[0] === i), sm.map(s => s.name));
    ok('phone: the phone layout; every name in one line (ОНІСУКА ТАЙГЕР too — owner 14.10.2026)', sm.every(s => s.layout === 'm' && s.lines === 1), sm.map(s => [s.layout, s.lines]));
    ok('phone: the lettering stays inside the screen', sm.every(s => s.ink[0] >= 0 && s.ink[1] <= s.vw), sm.map(s => s.ink));
    ok('phone: the list fits in the one-screen part', await p.evaluate(() => document.querySelector('.lu-pl').getBoundingClientRect().bottom <= document.querySelector('.lu-pin').getBoundingClientRect().bottom + 0.5));
    ok('phone: no console errors', errs.length === 0, errs.join(' | '));
    await ctx.close();

    /* ---------------- a tablet held upright: the tall layout */
    ({ p, ctx } = await open(b, 820, 1180));
    await toLineup(p); await pick(p, 3);
    const st = await state(p);
    ok('portrait 820 × 1180: the tall layout, ОНІСУКА ТАЙГЕР in one line', st.layout === 'm' && st.lines === 1, st);
    await ctx.close();

    /* ---------------- reduced motion: no cycle, the list shows a name at once */
    ({ p, ctx } = await open(b, 1280, 720, true));
    await toLineup(p); await watch(p); await p.waitForTimeout(4000);
    const still = await seenNames(p);
    await p.click('.lu-pl button[data-n="4"]'); await p.waitForTimeout(60);
    const sr = await state(p);
    ok('reduced motion: no cycle; a name from the list shows at once, at its full width', still.length === 1 && sr.name === NAMES[4] && Math.abs(sr.wdth[0] - sr.target[0]) < 0.2, { still, sr });
    await ctx.close();

    /* ---------------- no sideways scroll */
    const over = [];
    for (const [w, h] of [[320, 568], [360, 640], [390, 844], [820, 1180], [1280, 720], [1920, 1080], [2560, 1440]]) {
      ({ p, ctx } = await open(b, w, h));
      await toLineup(p);
      for (const i of [0, 3, 5]) { await pick(p, i); const o = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); const s = await state(p); if (o > 0 || s.ink[0] < 0 || s.ink[1] > s.vw) over.push([w, i, o, s.ink]); }
      const fit = await p.evaluate(() => document.querySelector('.lu-pl').getBoundingClientRect().bottom <= document.querySelector('.lu-pin').getBoundingClientRect().bottom + 0.5);
      if (!fit) over.push([w, 'list below the one-screen part']);
      await ctx.close();
    }
    ok('320–2560 px: no sideways scroll, the names and the list stay on screen', over.length === 0, over);
  } catch (e) { console.log('ABORTED: ' + e.message); failed++; }
  await b.close();
  console.log('\n' + n + ' checks, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
