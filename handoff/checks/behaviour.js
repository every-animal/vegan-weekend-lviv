// Behaviour checks for the Веган Вікенд Львів page.
// They describe what the approved design does; a ported site must pass them with the same expectations.
//
//   1. serve the page you want to check over http (not file://). For the reference:   cd reference && python3 -m http.server 8080
//      (the server keeps that terminal busy: run the next steps in a second terminal, from the package root)
//   2. npm i playwright && npx playwright install chromium
//   3. node checks/behaviour.js http://localhost:8080/        <- the address of the page under test: the reference, or the site being built
//
// The page must be complete: a missing element stops the run (the results collected so far are printed, exit code 1).
// These are smoke checks of behaviour, not a visual comparison and not a proof: see checks/README.md for what they do not catch.
//
// 48 checks: desktop (1280x720), phone (390x844) and prefers-reduced-motion. Exit code 1 if any fails.
// The checks find elements by the class names of the reference page; if a port renames them, update the selectors, not the expectations.
const { chromium } = require('playwright');
const U=process.argv[2];
if(!U){console.error('usage: node checks/behaviour.js <url of the page>');process.exit(2);}
const ORIGIN=new URL(U).origin+'/';
const CARD=()=>{const c=document.querySelector('.cbn');return !c||c.hidden||getComputedStyle(c).display==='none'};   // true when the cookie card is gone
const LISTEN=()=>{window._ck=[];document.addEventListener('vw-cookies',e=>window._ck.push(e.detail.accepted))};
const res=[];const ok=(name,cond,info)=>{res.push([cond?'PASS':'FAIL',name,info||'']);};
(async()=>{const b=await chromium.launch({args:['--no-proxy-server']});
  // ---------- desktop
  let ctx=await b.newContext({viewport:{width:1280,height:720},permissions:['clipboard-read','clipboard-write']});let p=await ctx.newPage();const er=[],reqs=[],bad=[];
  p.on('pageerror',e=>er.push(e.message));p.on('console',m=>{if(m.type()==='error')er.push(m.text())});p.on('response',r=>{reqs.push(r.url());if(r.status()>=400)bad.push(r.status()+' '+r.url())});p.on('requestfailed',r=>bad.push('failed '+r.url()));
  await p.goto(U);await p.waitForTimeout(3000);
  const go=async y=>{await p.evaluate(v=>window.scrollTo({top:v,behavior:'instant'}),y);};
  const Y=sel=>p.evaluate(s=>{const r=document.querySelector(s).getBoundingClientRect();return r.top+scrollY},sel);
  ok('desktop: no console errors',er.length===0,er.join(' | '));ok('desktop: no failed or 4xx requests',bad.length===0,bad.join(' | '));
  ok('fonts: both Heading Now files loaded',await p.evaluate(async()=>{await document.fonts.ready;return document.fonts.check('16px "Heading Now"')&&document.fonts.check('italic 16px "Heading Now"')&&[...document.fonts].filter(f=>f.status==='loaded').length>=2}));
  ok('requests stay inside the package (no external hosts)',reqs.every(u=>u.startsWith(ORIGIN)),reqs.filter(u=>!u.startsWith(ORIGIN)).join(','));
  ok('ticket links: 7, all to WayForPay',await p.evaluate(()=>[...document.querySelectorAll('a')].filter(a=>a.href==='https://secure.wayforpay.com/payment/vegan_weekend_lviv').length===7));
  ok('no template leftovers ({{, /_blob/, x-dc, support.js)',await p.evaluate(()=>!/\{\{|\/_blob\/|x-dc|support\.js/.test(document.documentElement.outerHTML)));
  const cd1=await p.evaluate(()=>['d','h','m','s'].map(k=>document.querySelector('[data-cd="'+k+'"]').textContent).join(':'));await p.waitForTimeout(1300);const cd2=await p.evaluate(()=>['d','h','m','s'].map(k=>document.querySelector('[data-cd="'+k+'"]').textContent).join(':'));
  ok('countdown runs',/^\d+:\d\d:\d\d:\d\d$/.test(cd1)&&cd1!==cd2,cd1+' → '+cd2);
  const it1=await p.evaluate(()=>[...document.querySelectorAll('.L')].map(e=>e.classList.contains('it')?1:0).join(''));await p.waitForTimeout(5400);const it2=await p.evaluate(()=>[...document.querySelectorAll('.L')].map(e=>e.classList.contains('it')?1:0).join(''));
  ok('hero letters switch by themselves',it1!==it2,it1+' → '+it2);
  ok('reveal: some blocks wait below the fold at load',await p.evaluate(()=>document.querySelectorAll('.rv.pre').length)>0);
  // cookie card (it covers the lower left corner, so it is answered before the other checks)
  const ck=await p.evaluate(()=>{const c=document.querySelector('.cbn'),r=c.getBoundingClientRect(),cs=getComputedStyle(c);return [cs.position,c.offsetWidth,Math.round(innerHeight-r.bottom),Math.round(r.left),cs.backgroundColor,cs.color,cs.rotate,Number(cs.zIndex)<Number(getComputedStyle(document.querySelector('.nav')).zIndex)]});
  ok('cookie card: fixed in the lower left corner, 440 wide, pink with grey text, tilted, under the nav',ck[0]==='fixed'&&ck[1]===440&&ck[2]===24&&ck[3]<40&&ck[4]==='rgb(254, 117, 190)'&&ck[5]==='rgb(109, 109, 109)'&&ck[6]==='-2deg'&&ck[7],JSON.stringify(ck));
  await p.hover('.cbn .btn');await p.waitForTimeout(350);const ey1=await p.evaluate(()=>getComputedStyle(document.querySelector('.cbn-eye')).scale);await p.hover('.cbn-no');await p.waitForTimeout(350);const ey2=await p.evaluate(()=>getComputedStyle(document.querySelector('.cbn-eye')).scale);
  ok('cookie card: the eyes open wide over «Дивіться» and shut over «Не підглядайте»',ey1==='1.13'&&ey2==='1 0.09',ey1+' → '+ey2);
  await p.evaluate(LISTEN);await p.click('.cbn-no');await p.waitForTimeout(150);const ckl=await p.evaluate(()=>document.querySelector('.cbn').classList.contains('no'));await p.waitForTimeout(750);
  ok('cookie card: «Не підглядайте» sends it away, removes it and announces a refusal',ckl&&await p.evaluate(CARD)&&await p.evaluate(()=>JSON.stringify(window._ck))==='[false]',String(await p.evaluate(()=>JSON.stringify(window._ck))));await p.mouse.move(640,200);
  // hero condenses
  await go(300);await p.waitForTimeout(200);ok('hero title condenses with the scroll (--hs)',parseFloat(await p.evaluate(()=>document.querySelector('[data-hero]').style.getPropertyValue('--hs')))>0.3);
  // manifesto scrub
  const ym=await Y('.mani');await go(ym-720*0.95);await p.waitForTimeout(200);const w0=await p.evaluate(()=>[...document.querySelectorAll('.mani .w')].filter(e=>e.style.transform).length);
  await go(ym-720*0.2);await p.waitForTimeout(200);const w1=await p.evaluate(()=>[...document.querySelectorAll('.mani .w')].filter(e=>e.style.transform).length);
  await go(ym-720*0.95);await p.waitForTimeout(200);const w2=await p.evaluate(()=>[...document.querySelectorAll('.mani .w')].filter(e=>e.style.transform).length);
  ok('manifesto: words come in with the scroll and go back out',w0>5&&w1===0&&w2===w0,`unfinished words ${w0} → ${w1} → ${w2}`);
  // eyes
  const yp=await Y('.pov-t');await go(yp-200);await p.mouse.move(100,100);await p.waitForTimeout(300);const e1=await p.evaluate(()=>document.querySelector('.pupil').style.transform);await p.mouse.move(1200,650);await p.waitForTimeout(300);const e2=await p.evaluate(()=>document.querySelector('.pupil').style.transform);
  ok('pupils follow the pointer',e1&&e2&&e1!==e2,e1+' → '+e2);
  // flip
  const zc=await p.evaluate(()=>{const n=document.querySelector('.z .z-n'),bt=document.querySelector('.pov-act [data-act="flip"]');const c0=getComputedStyle(n).color;bt.click();const c1=getComputedStyle(n).color;bt.click();return [c0,c1,getComputedStyle(n).color]});
  ok('change of the point of view recolours the zone rows at once, without a fade',zc[0]==='rgb(254, 117, 190)'&&zc[1]==='rgb(109, 109, 109)'&&zc[2]===zc[0],zc.join(' → '));
  await p.keyboard.press('Shift');   // a key press: from here the browser shows focus rings, as it does for someone who uses the keyboard
  const fr=await p.evaluate(()=>['.fund-grid .btn','.tix-cta .btn','.hero-cta .btn'].map(s=>{const e=document.querySelector(s);e.focus({focusVisible:true});const cs=getComputedStyle(e);const r=[cs.outlineStyle+' '+cs.outlineWidth,cs.outlineColor,getComputedStyle(e.closest('section,header')).backgroundColor];e.blur();return r}));
  ok('keyboard focus ring is 3px and never the colour of the section behind the button',fr.every(v=>v[0]==='solid 3px'&&v[1]!==v[2]),JSON.stringify(fr));
  const BG=()=>['[data-vw]','.hero','#about'].map(s=>getComputedStyle(document.querySelector(s)).backgroundColor).join(' ');const bg1=await p.evaluate(BG);await p.click('.pov-act [data-act="flip"]');await p.waitForTimeout(150);const bg2=await p.evaluate(BG);
  ok('change of the point of view swaps the colours (root, a grey section, a pink section)',bg1==='rgb(109, 109, 109) rgb(109, 109, 109) rgb(254, 117, 190)'&&bg2==='rgb(254, 117, 190) rgb(254, 117, 190) rgb(109, 109, 109)',bg1+' → '+bg2);await p.click('.pov-act [data-act="flip"]');
  // zones width
  const yz=await Y('.z');await go(yz-360);await p.waitForTimeout(350);const wd=await p.evaluate(()=>[...document.querySelectorAll('.z-t')].map(e=>+e.style.getPropertyValue('--wd')));
  ok('zone titles widen near the middle of the screen',Math.max(...wd)>500&&Math.min(...wd)<300,wd.join(','));
  // stats
  const ys=await Y('.stats');await go(ys-300);await p.waitForTimeout(500);const s1=await p.evaluate(()=>[...document.querySelectorAll('.stat-n>span')].map(e=>e.className).join(','));
  await go(0);await p.waitForTimeout(400);const s2=await p.evaluate(()=>[...document.querySelectorAll('.stat-n>span')].map(e=>e.className).join(','));
  await go(ys-300);await p.waitForTimeout(500);const s3=await p.evaluate(()=>[...document.querySelectorAll('.stat-n>span')].map(e=>e.className).join(','));
  ok('numbers: spring plays, rewinds off screen, plays again',s1==='go,go,go'&&s2==='pre,pre,pre'&&s3==='go,go,go',[s1,s2,s3].join(' | '));
  // route
  const yr=await Y('[data-route]');await go(yr-720);await p.waitForTimeout(300);const r0=await p.evaluate(()=>[document.querySelector('.rt-d .rt-l').style.strokeDashoffset,document.querySelectorAll('[data-route] .on').length]);
  await go(yr+100);await p.waitForTimeout(700);const r1=await p.evaluate(()=>[document.querySelector('.rt-d .rt-l').style.strokeDashoffset,document.querySelectorAll('[data-route] .on').length]);
  await go(yr-720);await p.waitForTimeout(300);const r2=await p.evaluate(()=>document.querySelectorAll('[data-route] .on').length);
  ok('route draws with the scroll, stops switch on and off',parseFloat(r0[0])===1&&r0[1]===0&&parseFloat(r1[0])===0&&r1[1]>=7&&r2===0,JSON.stringify([r0,r1,r2]));
  // copy
  await go(yr+100);await p.waitForTimeout(500);await p.click('[data-act="copy"]');await p.waitForTimeout(300);const c1=await p.evaluate(async()=>[document.querySelector('[data-act="copy"]').classList.contains('ok'),await navigator.clipboard.readText()]);await p.waitForTimeout(1500);const cm=await p.evaluate(()=>document.querySelector('[data-act="copy"]').classList.contains('ok'));await p.waitForTimeout(800);const c2=await p.evaluate(()=>document.querySelector('[data-act="copy"]').classList.contains('ok'));
  ok('address is copied and the button says so for 2.2 s (still on at 1.8 s, off at 2.6 s)',c1[0]&&c1[1]==='Jam Factory Art Center, вул. Богдана Хмельницького, 124, Львів'&&cm&&!c2,c1[1]+' | at 1.8 s: '+cm+', at 2.6 s: '+c2);
  // ticket tilt
  const yt=await Y('.ticket');await go(yt-200);await p.waitForTimeout(300);const tb=await p.evaluate(()=>{const r=document.querySelector('.ticket').getBoundingClientRect();return [r.left+r.width*0.8,r.top+r.height*0.3]});await p.mouse.move(tb[0],tb[1]);await p.waitForTimeout(250);const t1=await p.evaluate(()=>document.querySelector('.ticket').style.transform);await p.mouse.move(5,5);await p.waitForTimeout(250);const t2=await p.evaluate(()=>document.querySelector('.ticket').style.transform);
  ok('ticket tilts towards the pointer and lets go',/rotateX/.test(t1)&&t2==='',t1+' → «'+t2+'»');
  // everything revealed after a full pass
  const H=await p.evaluate(()=>document.documentElement.scrollHeight);for(let y=0;y<H;y+=500){await go(y);await p.waitForTimeout(60);}await p.waitForTimeout(300);
  ok('after scrolling the whole page no block is left hidden',await p.evaluate(()=>document.querySelectorAll('.rv.pre').length)===0);
  ok('desktop: both marquees run, swipe mode is off',await p.evaluate(()=>['.strip','.revs'].every(s=>getComputedStyle(document.querySelector(s+' .mq-t')).animationName==='vw-mq'&&getComputedStyle(document.querySelector(s)).overflowX==='hidden')));
  ok('desktop: still no console errors after all of the above',er.length===0,er.join(' | '));await ctx.close();
  // ---------- phone
  ctx=await b.newContext({viewport:{width:390,height:844},hasTouch:true});p=await ctx.newPage();const er2=[];p.on('pageerror',e=>er2.push(e.message));p.on('console',m=>{if(m.type()==='error')er2.push(m.text())});
  await p.goto(U);await p.waitForTimeout(2500);const go2=async y=>{await p.evaluate(v=>window.scrollTo({top:v,behavior:'instant'}),y);};const Y2=sel=>p.evaluate(s=>{const r=document.querySelector(s).getBoundingClientRect();return r.top+scrollY},sel);
  const ytk=await p.evaluate(()=>{const r=document.querySelector('[data-tilt]').getBoundingClientRect();return r.top+scrollY+r.height/2});await go2(ytk-281);await p.waitForTimeout(400);
  ok('ticket stays flat until a mouse moves over it',await p.evaluate(()=>document.querySelector('[data-tilt]').style.transform)==='',await p.evaluate(()=>document.querySelector('[data-tilt]').style.transform));await go2(0);await p.waitForTimeout(800);   // the card rides in after the first scroll — let it finish (owner's decision 05.10.2026)
  const ckm=await p.evaluate(()=>{const c=document.querySelector('.cbn'),r=c.getBoundingClientRect(),t=c.querySelector('.cbn-t'),h=c.querySelector('.cbn-h');return [c.offsetWidth,c.offsetHeight,Math.round(innerHeight-r.bottom),Math.round(h.offsetHeight/parseFloat(getComputedStyle(h).fontSize)*10)/10,Math.round(t.offsetHeight/parseFloat(getComputedStyle(t).lineHeight)),t.innerText.replace(/\u00a0/g,' ')]});
  ok('phone: the cookie card is the small one — under 160 high, heading in one line, short text in two',ckm[0]===366&&ckm[1]<160&&ckm[2]===12&&ckm[3]<1.6&&ckm[4]===2&&ckm[5]==='COOKIES: АНАЛІТИКА Й РЕКЛАМА. НАМ ЦЕ ДУЖЕ ДОПОМАГАЄ — БІЛЬШЕ ЛЮДЕЙ, БІЛЬШИЙ ЗБІР.',JSON.stringify(ckm));
  await p.click('.nav-bg');await p.waitForTimeout(1500);ok('phone: the open menu covers the cookie card',await p.evaluate(()=>{const r=document.querySelector('.cbn').getBoundingClientRect();return !!document.elementFromPoint(r.left+r.width/2,r.top+r.height/2).closest('.mnav')}));await p.click('.nav-bg');await p.waitForTimeout(300);
  await p.evaluate(LISTEN);await p.click('.cbn .btn');await p.waitForTimeout(900);
  ok('phone: «Дивіться» removes the card and announces consent',await p.evaluate(CARD)&&await p.evaluate(()=>JSON.stringify(window._ck))==='[true]',String(await p.evaluate(()=>JSON.stringify(window._ck))));
  ok('phone: short logo and burger are shown',await p.evaluate(()=>getComputedStyle(document.querySelector('.nl-s')).display==='block'&&getComputedStyle(document.querySelector('.nl-f')).display==='none'&&getComputedStyle(document.querySelector('.nav-bg')).display==='block'));
  await p.click('.nav-bg');await p.waitForTimeout(1500);const m1=await p.evaluate(()=>{const mn=document.querySelector('.mnav');const bs=[...mn.querySelectorAll('.mn-b .btn')].map(x=>x.getBoundingClientRect());return [document.querySelector('[data-vw]').classList.contains('menu'),document.querySelector('.nav-bg').getAttribute('aria-expanded'),document.documentElement.style.overflow,bs.length===2&&bs.every(r=>r.height>0&&r.bottom<=innerHeight&&r.top>=56),mn.scrollHeight<=mn.clientHeight]});
  ok('phone menu: opens, locks the page scroll, both buttons inside the screen',m1[0]&&m1[1]==='true'&&m1[2]==='hidden'&&m1[3]&&m1[4],JSON.stringify(m1));
  await p.keyboard.press('Escape');await p.waitForTimeout(200);ok('phone menu: Escape closes it and frees the scroll',await p.evaluate(()=>!document.querySelector('[data-vw]').classList.contains('menu')&&document.documentElement.style.overflow===''));
  await p.click('.nav-bg');await p.waitForTimeout(300);await p.click('.mnav a[href="#place"]');await p.waitForTimeout(1200);ok('phone menu: a section link closes it and scrolls there',await p.evaluate(()=>!document.querySelector('[data-vw]').classList.contains('menu')&&Math.abs(document.querySelector('#place').getBoundingClientRect().top-56)<8),String(await p.evaluate(()=>document.querySelector('#place').getBoundingClientRect().top)));
  const yb=await Y2('.pov-body');await go2(yb-300);await p.waitForTimeout(400);const f0=await p.evaluate(()=>[document.querySelector('.pov-x').getBoundingClientRect().height,document.querySelector('.tm').getAttribute('aria-expanded'),document.querySelector('.tm').getAttribute('role')]);await p.click('.tm');await p.waitForTimeout(800);const f1=await p.evaluate(()=>[document.querySelector('.pov-x').getBoundingClientRect().height,document.querySelector('.tm').getAttribute('aria-expanded')]);await p.focus('.tm');await p.keyboard.press('Enter');await p.waitForTimeout(800);const f2=await p.evaluate(()=>document.querySelector('.pov-x').getBoundingClientRect().height);
  ok('phone: «тему» unfolds and folds the explanation (tap and keyboard)',f0[0]===0&&f0[1]==='false'&&f0[2]==='button'&&f1[0]>80&&f1[1]==='true'&&f2===0,JSON.stringify([f0,f1,f2]));
  const yg=await Y2('.strip');await go2(yg-200);await p.waitForTimeout(400);const sw0=await p.evaluate(()=>{const e=document.querySelector('.strip');const cs=getComputedStyle(e);return [cs.overflowX,cs.scrollSnapType,getComputedStyle(e.querySelector('.mq-t')).animationName,getComputedStyle(e.querySelectorAll('.mq-t')[1]).display,e.scrollLeft]});
  const bx=await p.evaluate(()=>{const r=document.querySelector('.strip').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]});await p.mouse.move(bx[0]+60,bx[1]);await p.mouse.down();await p.mouse.move(bx[0]-60,bx[1],{steps:8});await p.mouse.up();await p.waitForTimeout(900);const sw1=await p.evaluate(()=>{const e=document.querySelector('.strip');return [e.scrollLeft,Math.round(e.querySelectorAll('.mq-t:not([aria-hidden])>*')[1].getBoundingClientRect().left)]});
  ok('phone: gallery is a snap row and moves one card per drag',sw0[0]==='auto'&&/x mandatory/.test(sw0[1])&&sw0[2]==='none'&&sw0[3]==='none'&&sw0[4]===0&&sw1[0]>200&&Math.abs(sw1[1]-16)<10,JSON.stringify([sw0,sw1]));
  const yr2=await Y2('[data-route]');await go2(yr2+200);await p.waitForTimeout(700);const pin=await p.evaluate(()=>{const svg=document.querySelector('.rt-m'),path=svg.querySelector('.rt-l'),L=path.getTotalLength(),e=path.getPointAtLength(L),vb=svg.viewBox.baseVal,sr=svg.getBoundingClientRect(),pr=document.querySelector('.place-pin').getBoundingClientRect();return [Math.round(sr.left+e.x/vb.width*sr.width-(pr.left+pr.width/2)),Math.round(sr.top+e.y/vb.height*sr.height-(pr.top+pr.height/2))]});
  ok('phone: the pin sits on the end of the route line',Math.abs(pin[0])<=1&&Math.abs(pin[1])<=1,JSON.stringify(pin));
  ok('phone: no console errors',er2.length===0,er2.join(' | '));await ctx.close();
  // ---------- reduced motion
  for(const [w,h] of [[1280,720],[390,844]]){ctx=await b.newContext({viewport:{width:w,height:h},reducedMotion:'reduce'});p=await ctx.newPage();await p.goto(U);await p.waitForTimeout(2000);
    await p.evaluate(()=>window.scrollBy(0,1));await p.waitForTimeout(100);   // the card waits for the first scroll (owner's decision 05.10.2026)
    const ckr=await p.evaluate(()=>{const c=document.querySelector('.cbn'),r=c.getBoundingClientRect();return [Math.round(r.top)>=0&&Math.round(r.bottom)<=innerHeight,getComputedStyle(c).animationName]});await p.click('.cbn-no');await p.waitForTimeout(150);
    ok(`reduced motion ${w}px: the cookie card is simply there, and simply gone after the answer`,ckr[0]&&ckr[1]==='none'&&await p.evaluate(CARD),JSON.stringify(ckr));
    const H2=await p.evaluate(()=>document.documentElement.scrollHeight);for(let y=0;y<H2;y+=h*0.8){await p.evaluate(v=>window.scrollTo({top:v,behavior:'instant'}),y);await p.waitForTimeout(60);}
    const hid=await p.evaluate(()=>{const out=[];document.querySelectorAll('[data-vw] *').forEach(e=>{const cs=getComputedStyle(e);if(cs.display==='none')return;if(e.matches('.z-ph,.pov-x,.pov-x *,.mnav,.mnav *,.cp-b'))return;if(e.closest('.wall,.mq-t[aria-hidden]'))return;const zero=cs.opacity==='0'||cs.scale==='0'||cs.visibility==='hidden';if(zero&&(e.textContent.trim()||/^(IMG|circle|A)$/.test(e.tagName)))out.push((e.className.baseVal!==undefined?e.className.baseVal:e.className)+'')});return out});
    const anim=await p.evaluate(()=>[...document.querySelectorAll('[data-vw] *')].filter(e=>getComputedStyle(e).animationName!=='none').length);
    ok(`reduced motion ${w}px: nothing is hidden, nothing animates`,hid.length===0&&anim===0,hid.slice(0,5).join(',')+' animated:'+anim);
    const rows=await p.evaluate(()=>['.strip','.revs'].map(s=>{const e=document.querySelector(s);const its=e.querySelectorAll('.mq-t:not([aria-hidden]) > *');e.scrollLeft=1e6;const r=its[its.length-1].getBoundingClientRect();const v=[getComputedStyle(e).overflowX,its.length,Math.round(r.left),Math.round(r.right),innerWidth];e.scrollLeft=0;return v}));
    ok(`reduced motion ${w}px: gallery and reviews can be scrolled by hand to the last card`,rows.every(v=>v[0]==='auto'&&v[1]>=8&&v[2]>=0&&v[3]<=v[4]),JSON.stringify(rows));
    const yc=await p.evaluate(()=>document.querySelector('.coon-track').getBoundingClientRect().bottom+scrollY);await p.evaluate(([v,hh])=>window.scrollTo({top:v-hh+120,behavior:'instant'}),[yc,h]);await p.waitForTimeout(200);
    const cn=await p.evaluate(()=>{const e=document.querySelector('.coon'),r=e.getBoundingClientRect();return [Math.round(r.left),Math.round(r.right),Math.round(r.top),Math.round(r.bottom),innerWidth,innerHeight,e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&r.width>40]});
    ok(`reduced motion ${w}px: the raccoon stands where he can be seen`,cn[6]&&cn[0]>=0&&cn[1]<=cn[4]&&cn[2]>=0&&cn[3]<=cn[5],cn.join(','));
    if(w===1280){const yr2=await p.evaluate(()=>document.querySelector('.revs').getBoundingClientRect().top+scrollY);await p.evaluate(v=>window.scrollTo({top:v-150,behavior:'instant'}),yr2);await p.mouse.move(5,5);await p.waitForTimeout(200);
      const c0=await p.evaluate(()=>{const e=document.querySelectorAll('.revs .mq-t:not([aria-hidden]) .rev')[1];const r=e.getBoundingClientRect();return [getComputedStyle(e).rotate,r.left+r.width/2,r.top+r.height/2]});await p.mouse.move(c0[1],c0[2]);await p.waitForTimeout(200);
      const c1=await p.evaluate(()=>{const e=document.querySelector('.revs .rev:hover');return e?[getComputedStyle(e).rotate,getComputedStyle(e).scale]:['no hover','']});
      ok('review card under the pointer straightens and grows',c0[0]!=='0deg'&&c1[0]==='0deg'&&c1[1]==='1.05',c0[0]+' → '+c1.join(' '));
      ok('reduced motion: a jump to a section is not animated',await p.evaluate(()=>getComputedStyle(document.documentElement).scrollBehavior)==='auto');}
    await ctx.close();}
  let f=0;for(const r of res){console.log(r[0],r[1],r[2]?'— '+String(r[2]).slice(0,150):'');if(r[0]==='FAIL')f++;}
  console.log(`\n${res.length} checks, ${f} failed`);await b.close();process.exit(f?1:0)})().catch(e=>{for(const r of res)console.log(r[0],r[1],r[2]?'— '+String(r[2]).slice(0,150):'');console.log(`\nABORTED after ${res.length} checks: ${e.message.split('\n')[0]}\n(an element the checks look for is probably missing from the page)`);process.exit(1)})
