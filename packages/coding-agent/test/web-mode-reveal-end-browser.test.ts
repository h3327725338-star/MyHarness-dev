import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// The end of the mode reveal flashed the old page (seen in a 60 frames/s screen recording of the desktop app, 2026-11-15):
// right after the circle had filled the window, one frame showed the whole page being left, then the new page again. The
// reveal's animation and the View Transition's layers can leave the screen in different frames; the new page's layer
// without its animation fell back to the stylesheet's hidden start (a zero-size circle), so the old page's picture
// underneath showed through for that frame. Now, once a forward reveal has drawn a frame of its own, the new page's layer
// drawn without the animation is the whole page (where the reveal ends); going back, it is hidden (where that ends); and
// the next reveal starts hidden again. Here the animation is taken away while the transition's layers are still up (a
// second animation keeps them), which is the moment in question, and the layer is read as it is then drawn.
const installed = detectInstalledBrowsers();

const page = `
import {setView} from '/js/store.js';
import {revealMode,reverseModeReveal} from '/js/mode-transition.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const frame=()=>new Promise(r=>requestAnimationFrame(()=>r()));
const must=(x,m)=>{if(!x)throw Error(m)};
const root=document.documentElement;
const stage=document.getElementById('stage');
const NEW='::view-transition-new(root)';
const clip=()=>getComputedStyle(root,NEW).clipPath;
const radius=(c)=>{const m=/^circle\\(([\\d.]+)px/.exec(c);return m?Number(m[1]):null;};
const reveal=()=>document.getAnimations().find(a=>a.effect?.pseudoElement===NEW);
// The transition ends once no animation runs on its layers: this one keeps them up after the reveal's goes.
const holdLayers=()=>root.animate([{opacity:1},{opacity:1}],{duration:4000,pseudoElement:'::view-transition-old(root)'});
const original=document.startViewTransition.bind(document);
// How the new page's layer is drawn when the transition is ready, before the reveal's animation takes it over.
const atReady=[];
document.startViewTransition=(update)=>{const t=original(update);t.ready.then(()=>atReady.push(clip()),()=>{});return t;};
try{
 setView({lang:'en',motion:'on'});
 must(document.visibilityState==='visible','no View Transition here: the mode reveal is not exercised');

 // (1) Forward: every frame of the circle is the animation's own (never the whole new page at once), and once the
 // animation is gone with the layers still up, the new page is drawn whole, not hidden over the old page.
 let hold=null;
 const done=revealMode(()=>{stage.dataset.page='general';},{from:'coding',to:'general'});
 const samples=[];
 const t0=performance.now();
 while(performance.now()-t0<300){await frame();const a=reveal();if(a){hold??=holdLayers();samples.push(clip());}}
 await done;
 must(atReady.length===1&&radius(atReady[0])===0,'(1) the new page was not hidden before the circle started: '+atReady.join(' | '));
 must(samples.length>=5,'(1) the reveal was not sampled while it ran: '+samples.length);
 must(samples.every(c=>radius(c)!==null),'(1) a frame of the circle was not the animation\\'s own: '+samples.slice(0,6).join(' | '));
 must(radius(samples[0])<radius(samples[samples.length-1]),'(1) the circle did not grow: '+samples[0]+' -> '+samples[samples.length-1]);
 reveal().cancel();
 await frame();
 must(clip()==='none','(1) without its animation the new page is hidden over the old page: '+clip());
 hold.cancel();
 const t1=performance.now();
 while(root.classList.contains('mode-revealing')&&performance.now()-t1<2000)await frame();
 must(!root.classList.contains('mode-revealing'),'(1) the reveal did not end once its layers were gone: '+document.getAnimations().filter(a=>a.effect?.pseudoElement).map(a=>a.effect.pseudoElement+' '+a.playState).join(', '));

 // (2) The next reveal starts hidden again: what held the last one's new page whole is gone before this one starts.
 hold=null;
 const back=revealMode(()=>{stage.dataset.page='coding';},{from:'general',to:'coding',restore:()=>{stage.dataset.page='general';}});
 const t2=performance.now();
 while(!reveal()&&performance.now()-t2<2000)await frame();
 must(reveal(),'(2) the next reveal did not start');
 must(atReady.length===2&&radius(atReady[1])===0,'(2) the new page was not hidden before the next circle started: '+atReady.join(' | '));
 hold=holdLayers();
 await wait(120);
 // (3) Turned around: it ends hidden, so without its animation the new page is hidden and the restored page shows.
 must(reverseModeReveal('general'),'(3) the reveal could not be turned around');
 await frame();
 reveal().cancel();
 await frame();
 must(radius(clip())===0,'(3) without its animation the new page of a reveal going back is not hidden: '+clip());
 hold.cancel();
 await back;
 await wait(100);
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error)+'</p>');}
`;

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"the mode reveal never leaves the new page hidden over the old page at its end",
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
