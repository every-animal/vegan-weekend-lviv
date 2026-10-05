// Makes the picture for social networks (reference/assets/social/og-image.png, 1200x630) from the page itself.
// Run it again if the title, the date, the logos or the text of the «Купити квиток» button in the hero change.
//
//   1. serve the page over http:   cd reference && python3 -m http.server 8080
//   2. npm i playwright && npx playwright install chromium
//   3. node tools/og-image.js http://localhost:8080/ reference/assets/social/og-image.png
//
// What it does: a 1200 px wide window with reduced motion (so nothing is caught mid-animation); the hero is forced to 630 px high
// (at 1200 px it is 619 px by itself); the navbar is not in the picture; the countdown, the round video button and the cookie card are hidden;
// the «Купити квиток» button is moved from its place in the hero to the middle of the free area under the title.
const { chromium } = require('playwright');
const URL_ = process.argv[2], OUT = process.argv[3] || 'og-image.png';
if (!URL_) { console.error('usage: node tools/og-image.js <url of the page> [output.png]'); process.exit(2); }
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1200, height: 686 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  await p.goto(URL_); await p.waitForTimeout(1500);
  await p.addStyleTag({ content: '.cdw,.play{visibility:hidden}.cbn{display:none !important}.hero{height:630px !important}' });
  await p.waitForTimeout(500);
  const m = await p.evaluate(() => {
    const h = document.querySelector('.hero').getBoundingClientRect(), bt = document.querySelector('.hero-cta .btn').getBoundingClientRect();
    return { top: h.top, x: bt.left + bt.width / 2, y: bt.top - h.top + bt.height / 2 };
  });
  // the free area: from the right end of the contour lines (x = 600) to the right edge, from the bottom of the title (y = 315) to the bottom of the picture
  const dx = Math.round((600 + 1200) / 2 - m.x), dy = Math.round((315 + 630) / 2 - m.y);
  await p.addStyleTag({ content: `.hero-cta{position:relative;left:${dx}px;top:${dy}px}` });
  await p.waitForTimeout(400);
  await p.screenshot({ path: OUT, clip: { x: 0, y: m.top, width: 1200, height: 630 } });
  console.log('saved', OUT, '— the button was moved by', dx, 'px across and', dy, 'px down');
  await b.close();
})();
