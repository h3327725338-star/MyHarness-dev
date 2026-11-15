import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// The mode reveal flashed the old page: one frame in the middle or at the end of the growing circle showed the whole
// page being left, then the reveal went on (seen in a 180 frames/s screen recording of the desktop app, 2026-11-15, about
// once in 26 switches, and reproduced under load frame by frame). The circle was an animated clip-path, which Chromium
// runs on the compositor from its own copy of the animation's value; a frame that found no value there drew the new
// page's layer as first painted, a circle of zero size. Now the page animates three registered lengths on that layer and
// the clip-path only reads them. What is checked here: the reveal animates those lengths and nothing animates a
// clip-path; every frame of a reveal draws a circle that is at least as large as the one before (as small, played
// back), from hidden to the whole window, until the transition's layers are gone; and the next reveal starts hidden.
const installed = detectInstalledBrowsers();

const page = `
import {setView} from '/js/store.js';
import {revealMode,reverseModeReveal} from '/js/mode-transition.js';
const frame=()=>new Promise(r=>requestAnimationFrame(()=>r()));
const must=(x,m)=>{if(!x)throw Error(m)};
const root=document.documentElement;
const stage=document.getElementById('stage');
const NEW='::view-transition-new(root)';
const clip=()=>getComputedStyle(root,NEW).clipPath;
const radius=(c)=>{const m=/^circle\\(([\\d.]+)px/.exec(c);return m?Number(m[1]):null;};
const onLayer=()=>document.getAnimations().filter(a=>a.effect?.pseudoElement===NEW);
const animated=(a)=>[...new Set(a.effect.getKeyframes().flatMap(k=>Object.keys(k)))].filter(k=>!['offset','easing','composite','computedOffset'].includes(k)).sort().join(',');
const original=document.startViewTransition.bind(document);
// How the new page's layer is drawn when the transition is ready, before the reveal's animation takes it over.
const atReady=[];
document.startViewTransition=(update)=>{const t=original(update);t.ready.then(()=>atReady.push(clip()),()=>{});return t;};
// One sample per frame for as long as the reveal is on screen: the circle drawn and what is animated.
const watch=async(each)=>{
 const samples=[];
 const t0=performance.now();
 while(!root.classList.contains('mode-revealing')&&performance.now()-t0<2000)await frame();
 while(root.classList.contains('mode-revealing')&&performance.now()-t0<5000){
  const list=onLayer();
  if(list.length){samples.push({r:radius(clip()),clip:clip(),count:list.length,props:list.map(animated).join(' | '),all:document.getAnimations().filter(a=>a.effect?.getKeyframes?.().some(k=>'clipPath' in k)).length});each?.(samples.length);}
  await frame();
 }
 return samples;
};
try{
 setView({lang:'en',motion:'on'});
 must(document.visibilityState==='visible','no View Transition here: the mode reveal is not exercised');
 const rect=document.querySelector('.mode-switch').getBoundingClientRect();
 const x=rect.left+rect.width/2,y=rect.top+rect.height/2;
 const full=Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y));

 // (1) Forward: hidden first, then a circle that only grows, drawn by the animated lengths, up to the whole window.
 const done=revealMode(()=>{stage.dataset.page='general';},{from:'coding',to:'general'});
 const forward=await watch();
 await done;
 must(atReady.length===1&&radius(atReady[0])===0,'(1) the new page was not hidden before the circle started: '+atReady.join(' | '));
 must(forward.length>=10,'(1) the reveal was not sampled while it ran: '+forward.length);
 must(forward.every(s=>s.r!==null),'(1) a frame did not draw the circle: '+forward.find(s=>s.r===null)?.clip);
 must(forward.every(s=>s.count===1&&s.props==='--mode-reveal-r,--mode-reveal-x,--mode-reveal-y'),'(1) the reveal does not animate its three lengths only: '+forward[0].props);
 must(forward.every(s=>s.all===0),'(1) something animates a clip-path: the compositor would run it');
 const shrink=forward.findIndex((s,i)=>i>0&&s.r<forward[i-1].r-0.5);
 must(shrink<0,'(1) the circle got smaller in a reveal going forward: '+forward.slice(Math.max(0,shrink-2),shrink+1).map(s=>s.r).join(' -> '));
 must(forward[forward.length-1].r>=full*0.85,'(1) the circle did not reach the whole window before its layers went: '+forward[forward.length-1].r+' of '+full);
 must(!root.classList.contains('mode-revealing'),'(1) the reveal did not end');
 must(onLayer().length===0,'(1) the animation of the reveal outlived its layers');

 // (2) The next reveal starts hidden again. (3) Turned around, the circle only shrinks and the old page is put back.
 let restored=0;
 let turned=-1;
 const back=revealMode(()=>{stage.dataset.page='coding';},{from:'general',to:'coding',restore:()=>{restored++;stage.dataset.page='general';}});
 const reverse=await watch((n)=>{if(n===8){must(reverseModeReveal('general'),'(3) the reveal could not be turned around');turned=n;}});
 await back;
 must(atReady.length===2&&radius(atReady[1])===0,'(2) the new page was not hidden before the next circle started: '+atReady.join(' | '));
 must(turned===8&&reverse.length>turned+3,'(3) the reveal was not sampled after it turned around: '+reverse.length);
 must(reverse.every(s=>s.r!==null&&s.count===1&&s.all===0),'(3) a frame of the reveal going back was not the one circle drawn by its lengths');
 const before=reverse.slice(0,turned),after=reverse.slice(turned);
 must(before.every((s,i)=>i===0||s.r>=before[i-1].r-0.5),'(3) the circle got smaller before it was turned around');
 const grow=after.findIndex((s,i)=>i>0&&s.r>after[i-1].r+0.5);
 must(grow<0,'(3) the circle grew again after it was turned around: '+after.slice(Math.max(0,grow-2),grow+1).map(s=>s.r).join(' -> '));
 must(after[after.length-1].r<before[before.length-1].r,'(3) the circle did not shrink after it was turned around');
 must(restored===1&&stage.dataset.page==='general','(3) the old page was not put back: '+restored+' '+stage.dataset.page);
 must(!root.classList.contains('mode-revealing')&&onLayer().length===0,'(3) the reveal going back did not end');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error)+'</p>');}
`;

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"the mode reveal is drawn by the page: its circle only grows and nothing animates a clip-path",
	async () => {
		const root = mkdtempSync(join(resolve(process.env.MYHARNESS_TEMP_DIR ?? tmpdir()), "mode-reveal-end-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			// The .mode-switch button gives the reveal a place to start from.
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><button class="mode-switch">mode</button><div id="stage" data-page="coding" style="height:400px"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(join(root, "test.js"), page);
			const { port } = await server.listen(0);
			const result = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/test/index.html`,
				readySelector: "#ready",
				label: "Mode reveal end",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(result.text.match(/id="ready">([^<]*)/)?.[1]).toBe("passed");
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90000,
);
