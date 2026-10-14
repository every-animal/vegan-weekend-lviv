// Перевірки секції «Лайнап» (варіант 04 «По одному»).
// Запуск: node checks/lineup.js http://localhost:8080/
// Сторінка має бути зібрана повністю; секція шукається за [data-lu], класами .lu-track, .lu-pin, .lu-svg, .lu-pl.
const { chromium } = require('playwright');
const URL = process.argv[2];
if (!URL) { console.log('usage: node checks/lineup.js <url of the page>'); process.exit(2); }
const NAMES = ['ЗЛИПНІ', 'LIPATOVA', 'СЕРВАНТ', 'ОНІСУКА ТАЙГЕР', 'OLES dj', 'BOH dj'];
const TICKET = 'https://secure.wayforpay.com/payment/vegan_weekend_lviv';
let n = 0, failed = 0;
const ok = (name, cond, detail) => { n++; if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); };

/* what the section shows right now: the name in the visible layout, the marked button, the width axis of its lines */
const state = p => p.evaluate(() => {
  const svg = [...document.querySelectorAll('.lu-svg')].find(s => getComputedStyle(s).display !== 'none');
  const ts = [...svg.querySelectorAll('defs text')].filter(t => t.textContent);
  const cur = [...document.querySelectorAll('.lu-pl button[aria-current="true"]')];
  const pin = document.querySelector('.lu-pin').getBoundingClientRect();
  const ink = svg.querySelector('.lu-f').getBoundingClientRect();
  return {
    name: ts.map(t => t.textContent).join(' '), lines: ts.length, layout: svg.classList.contains('lu-m') ? 'm' : 'd',
    wdth: ts.map(t => +((t.style.fontVariationSettings.match(/wdth'?"?\s*([\d.]+)/) || [])[1] || 0)),
    target: ts.map(t => { const d = JSON.parse(svg.getAttribute('data-names')); const i = d.findIndex(l => l.map(x => x[0]).join(' ') === ts.map(x => x.textContent).join(' ')); const k = [...svg.querySelectorAll('defs text')].indexOf(t); return i < 0 ? -1 : d[i][k][1]; }),
    cur: cur.map(b => +b.dataset.n), pinTop: Math.round(pin.top),
    ink: [Math.round(ink.left), Math.round(ink.right), Math.round(ink.top), Math.round(ink.bottom)], vw: innerWidth
  };
});
const geo = p => p.evaluate(() => { const t = document.querySelector('.lu-track'), pin = document.querySelector('.lu-pin'); return { doc: t.getBoundingClientRect().top + scrollY, total: t.offsetHeight - pin.offsetHeight, top: parseFloat(getComputedStyle(pin).top) }; });
const toStep = async (p, g, i) => { await p.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), Math.round(g.doc - g.top + g.total * (i + 0.5) / 6)); };
const open = async (b, w, h, reduce) => {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, reducedMotion: reduce ? 'reduce' : 'no-preference' });
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
    const g = await geo(p);
    ok('the section is six steps of scroll long', g.total > 600, g);
    const seen = [];
    for (let i = 0; i < 6; i++) { await toStep(p, g, i); await p.waitForTimeout(1300); seen.push(await state(p)); }
    ok('every step of the scroll shows its name, and only its button is marked', seen.every((s, i) => s.name === NAMES[i] && s.cur.length === 1 && s.cur[0] === i), seen.map(s => [s.name, s.cur]));
    ok('the section stays under the navbar while the names change (sticky)', seen.every(s => s.pinTop === Math.round(g.top)), seen.map(s => s.pinTop));
    ok('desktop: every name in one line, at its fitted width', seen.every(s => s.lines === 1 && s.layout === 'd' && Math.abs(s.wdth[0] - s.target[0]) < 0.2), seen.map(s => [s.wdth, s.target]));
    ok('desktop: the lettering stays inside the screen', seen.every(s => s.ink[0] >= 0 && s.ink[1] <= s.vw), seen.map(s => s.ink));
    /* the change: squeeze first, then grow back with a spring */
    await toStep(p, g, 2); await p.waitForTimeout(1300);
    await toStep(p, g, 3);
    const tr = [];
    for (const w of [120, 180, 300, 700]) { await p.waitForTimeout(w); tr.push(await state(p)); }   // at 0.12, 0.3, 0.6 and 1.3 s
    ok('a change squeezes the shown name, swaps it and grows the next one to its width', tr[0].name === NAMES[2] && tr[0].wdth[0] < tr[0].target[0] - 20 && tr[2].name === NAMES[3] && Math.abs(tr[3].wdth[0] - tr[3].target[0]) < 0.2, tr.map(s => [s.name, s.wdth[0], s.target[0]]));
    await toStep(p, g, 1); await p.waitForTimeout(1600);
    ok('scrolling back brings the earlier name back', (await state(p)).name === NAMES[1]);
    /* a jump from the list goes straight to the name */
    await toStep(p, g, 0); await p.waitForTimeout(1300);
    await p.evaluate(() => { window.__luSeen = []; const svg = [...document.querySelectorAll('.lu-svg')].find(s => getComputedStyle(s).display !== 'none'); new MutationObserver(() => { const t = svg.querySelector('defs text').textContent; if (window.__luSeen[window.__luSeen.length - 1] !== t) window.__luSeen.push(t); }).observe(svg, { subtree: true, childList: true, characterData: true }); });
    await p.click('.lu-pl button[data-n="5"]'); await p.waitForTimeout(2200);
    const js = await p.evaluate(() => window.__luSeen);
    const sj = await state(p);
    ok('a name in the list scrolls to its step and changes straight to it', sj.name === NAMES[5] && sj.cur[0] === 5 && js.length === 1, { seen: js, now: sj.name });
    await p.keyboard.press('Shift');
    await p.focus('.lu-pl button[data-n="2"]'); await p.keyboard.press('Enter'); await p.waitForTimeout(2200);
    ok('the list works from the keyboard', (await state(p)).name === NAMES[2]);
    ok('desktop: no console errors', errs.length === 0, errs.join(' | '));
    await ctx.close();

    /* ---------------- phone 390 × 844 */
    ({ p, ctx, errs } = await open(b, 390, 844));
    const gm = await geo(p);
    const sm = [];
    for (let i = 0; i < 6; i++) { await toStep(p, gm, i); await p.waitForTimeout(1300); sm.push(await state(p)); }
    ok('phone: every step shows its name', sm.every((s, i) => s.name === NAMES[i] && s.cur[0] === i), sm.map(s => s.name));
    ok('phone: the phone layout; ОНІСУКА ТАЙГЕР takes two lines, the others one', sm.every((s, i) => s.layout === 'm' && s.lines === (i === 3 ? 2 : 1)), sm.map(s => [s.layout, s.lines]));
    ok('phone: the lettering stays inside the screen', sm.every(s => s.ink[0] >= 0 && s.ink[1] <= s.vw), sm.map(s => s.ink));
    ok('phone: the list fits in the stuck part', await p.evaluate(() => document.querySelector('.lu-pl').getBoundingClientRect().bottom <= document.querySelector('.lu-pin').getBoundingClientRect().bottom + 0.5));
    ok('phone: no console errors', errs.length === 0, errs.join(' | '));
    await ctx.close();

    /* ---------------- a tablet held upright: the tall layout */
    ({ p, ctx } = await open(b, 820, 1180));
    const gt = await geo(p); await toStep(p, gt, 3); await p.waitForTimeout(1300);
    const st = await state(p);
    ok('portrait 820 × 1180: the tall layout with two lines', st.layout === 'm' && st.lines === 2, st);
    await ctx.close();

    /* ---------------- reduced motion */
    ({ p, ctx } = await open(b, 1280, 720, true));
    const gr = await geo(p); await toStep(p, gr, 0); await p.waitForTimeout(500);
    await toStep(p, gr, 4); await p.waitForTimeout(80);
    const sr = await state(p);
    ok('reduced motion: the name changes at once, at its full width', sr.name === NAMES[4] && Math.abs(sr.wdth[0] - sr.target[0]) < 0.2, sr);
    const y0 = await p.evaluate(() => scrollY);
    await p.click('.lu-pl button[data-n="1"]'); await p.waitForTimeout(60);
    const y1 = await p.evaluate(() => scrollY);
    ok('reduced motion: a jump from the list is not animated', (await state(p)).name === NAMES[1] && Math.abs(y1 - (gr.doc - gr.top + gr.total * 1.5 / 6)) < 2, [y0, y1]);
    await ctx.close();

    /* ---------------- no sideways scroll */
    const over = [];
    for (const [w, h] of [[320, 568], [360, 640], [390, 844], [820, 1180], [1280, 720], [1920, 1080], [2560, 1440]]) {
      ({ p, ctx } = await open(b, w, h));
      const gg = await geo(p);
      for (const i of [0, 3, 5]) { await toStep(p, gg, i); await p.waitForTimeout(1200); const o = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); const s = await state(p); if (o > 0 || s.ink[0] < 0 || s.ink[1] > s.vw) over.push([w, i, o, s.ink]); }
      const fit = await p.evaluate(() => document.querySelector('.lu-pl').getBoundingClientRect().bottom <= document.querySelector('.lu-pin').getBoundingClientRect().bottom + 0.5);
      if (!fit) over.push([w, 'list below the stuck part']);
      await ctx.close();
    }
    ok('320–2560 px: no sideways scroll, the names and the list stay on screen', over.length === 0, over);
  } catch (e) { console.log('ABORTED: ' + e.message); failed++; }
  await b.close();
  console.log('\n' + n + ' checks, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
