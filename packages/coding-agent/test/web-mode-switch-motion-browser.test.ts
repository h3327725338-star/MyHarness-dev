import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// Two things made the mode switch flicker (measured with a real browser, 2026-11-14):
//  - the colour theme flips with the mode, and every button, chip and border with a colour transition then faded from
//    the other mode's colours: inside the circle as it opened, and on the restored page the moment a reversed reveal
//    ended (the picture on screen changed again after the animation was over). The reveal now finishes the colour
//    transitions its own flip started, and only those: the switch keeps its colour motion.
//  - a click that turned a running slide of the knob around started the way back from the icon's progress, not from where
//    the knob was drawn, so the knob jumped across the track (15px) at the click. It now turns around where it is.
const installed = detectInstalledBrowsers();

const page = `
import {h,render} from '/vendor/preact.js';
import {ModeSwitch} from '/js/mode-switch.js';
import {setView} from '/js/store.js';
import {modeRevealActive,revealMode,reverseModeReveal} from '/js/mode-transition.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const frame=()=>new Promise(r=>requestAnimationFrame(()=>r()));
const must=(x,m)=>{if(!x)throw Error(m)};
const root=document.documentElement;
const probe=document.getElementById('probe');
// The colour transitions running on the page's own elements (the switch's are not counted).
const fading=()=>document.getAnimations().filter(a=>a instanceof CSSTransition&&/color/.test(a.transitionProperty)&&a.effect.target instanceof Element&&!a.effect.target.closest('.mode-switch')).map(a=>a.transitionProperty+' @ '+a.effect.target.className);
const switchFading=()=>document.getAnimations().filter(a=>a instanceof CSSTransition&&a.effect.target instanceof Element&&a.effect.target.closest('.mode-switch')).length;
try{
 setView({lang:'en',motion:'on',chatMode:'coding'});
 must(typeof document.startViewTransition==='function'&&document.visibilityState==='visible','no View Transition here: the mode reveal is not exercised');
 render(h(ModeSwitch,{}),document.getElementById('app'));
 await frame();await frame();
 must(root.dataset.colorTheme==='classic','setup: Coding is not on its colour theme: '+root.dataset.colorTheme);

 // (0) The premise: a plain flip of the theme does start colour transitions on the page's elements.
 setView({chatMode:'general'});
 const plain=fading();
 must(plain.length>0,'setup: a theme flip starts no colour transition, nothing to guard against');
 await wait(400);
 setView({chatMode:'coding'});
 await wait(400);

 // (1) A flip inside the reveal draws the new mode's colours at once, and the switch keeps its own colour motion.
 await revealMode(()=>setView({chatMode:'general'}),{from:'coding',to:'general',restore:()=>setView({chatMode:'coding'})});
 must(root.dataset.colorTheme==='forest','(1) the reveal did not flip the theme: '+root.dataset.colorTheme);
 const inside=fading();
 must(inside.length===0,'(1) colours faded inside the reveal: '+inside.slice(0,4).join(' | '));
 must(switchFading()>0,'(1) the switch lost its own colour motion');
 // (2) Turned around halfway: the restored page is in its own colours at once (no fade once the animation is over).
 await wait(150);
 must(reverseModeReveal('coding')===true,'(2) the reveal could not be turned around');
 let guard=0;
 while(modeRevealActive()&&guard++<200)await frame();
 must(!modeRevealActive(),'(2) the reversed reveal did not end');
 must(root.dataset.colorTheme==='classic','(2) the theme did not come back: '+root.dataset.colorTheme);
 const restored=fading();
 must(restored.length===0,'(2) colours faded on the restored page: '+restored.slice(0,4).join(' | '));
 await wait(800);

 // (3) The knob turns around where it is drawn. It slides toward General, is turned back late in the slide (where the icon's
 // own progress is far behind the knob), and must not jump at the click.
 const knob=document.querySelector('.mode-knob');
 const sw=document.querySelector('.mode-switch');
 const knobX=()=>{const m=/^matrix\\(([^)]+)\\)$/.exec(getComputedStyle(knob).transform);return m?Number(m[1].split(',')[4]):0;};
 must(Math.abs(knobX())<0.5,'(3) setup: the knob is not at rest at Coding: '+knobX());
 setView({modeIntent:'general'});
 const t0=performance.now();
 let last=knobX();
 while(performance.now()-t0<250){await frame();last=knobX();}
 must(last>20,'(3) setup: the knob has not slid far enough to be turned around: '+last);
 setView({modeIntent:'coding'});
 guard=0;
 while(!sw.classList.contains('coding')&&guard++<100)await frame();
 const after=knobX();
 must(Math.abs(after-last)<6,'(3) the knob jumped at the click: '+last.toFixed(1)+' -> '+after.toFixed(1));
 // and it still comes to rest at Coding
 await wait(900);
 must(Math.abs(knobX())<0.5,'(3) the knob did not come to rest at Coding: '+knobX());
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error)+'</p>');}
`;

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"the mode switch draws no colour fade inside the reveal and turns the knob around where it is",
	async () => {
		// The browser profile lives under it: Chrome shows an error box on the desktop for a relative profile path.
		const root = mkdtempSync(join(resolve(process.env.MYHARNESS_TEMP_DIR ?? tmpdir()), "mode-motion-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			// The probe is a button whose colours follow the theme through a transition (base.css), like the page's own.
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><div id="app" style="padding:20px"></div><button class="icon-btn" id="probe">x</button><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(join(root, "test.js"), page);
			const { port } = await server.listen(0);
			const result = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/test/index.html`,
				readySelector: "#ready",
				label: "Mode switch motion",
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
