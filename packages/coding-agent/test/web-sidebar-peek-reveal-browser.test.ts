import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// The Coding / General switch sits in the sidebar. With the sidebar floating (the peek), switching modes slid the
// floating sidebar away under the growing circle and back in once the reveal was over: the reveal's snapshot layers take
// the page out of hit testing, so the pointer "left" a sidebar it was still resting on, and "entered" it again afterwards.
// Now the close waits for the reveal to end and then goes by where the pointer was last seen. Checked here: the peek
// stays through the reveal; it stays afterwards when the pointer is still on the sidebar; and it closes right after the
// reveal when the pointer moved away during it. A pointer that was found on the sidebar by its position and then moves
// away without the browser sending a leave event (it never saw the pointer come back) closes the peek too.
const installed = detectInstalledBrowsers();

const page = `
import {setView} from '/js/store.js';
import {revealMode} from '/js/mode-transition.js';
import {peekButtonEnter,peekButtonLeave,peekSidebarEnter,peekSidebarLeave} from '/js/sidebar-peek.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const frame=()=>new Promise(r=>requestAnimationFrame(()=>r()));
const must=(x,m)=>{if(!x)throw Error(m)};
const root=document.documentElement;
const stage=document.getElementById('stage');
const sidebar=document.querySelector('.app > .sidebar');
const button=document.getElementById('show');
const peek=()=>root.dataset.sidebarPeek||'';
const mouse=(x,y,extra)=>({pointerType:'mouse',buttons:0,clientX:x,clientY:y,...extra});
// What the peek showed in every frame of one reveal.
const during=async()=>{
 const seen=new Set();
 const t0=performance.now();
 while(!root.classList.contains('mode-revealing')&&performance.now()-t0<2000)await frame();
 while(root.classList.contains('mode-revealing')&&performance.now()-t0<5000){seen.add(peek());await frame();}
 return [...seen].join(',');
};
try{
 setView({lang:'en',motion:'on',sidebarOpen:false});
 must(document.visibilityState==='visible','no View Transition here: the mode reveal is not exercised');
 // A button that lands under the pointer because the sidebar was just hidden does not peek: wait that out.
 await wait(700);
 const b=button.getBoundingClientRect();
 peekButtonEnter(mouse(b.left+5,b.top+5,{currentTarget:button}));
 await wait(450);
 must(peek()==='in','setup: the peek did not open: '+peek());
 const r=sidebar.getBoundingClientRect();
 const x=r.left+r.width/2,y=r.top+r.height/2;
 must(r.width>80&&sidebar.contains(document.elementFromPoint(x,y)),'setup: the floating sidebar is not under the pointer: '+JSON.stringify(r));
 peekButtonLeave(mouse(x,y));
 peekSidebarEnter(mouse(x,y));

 // (1) The pointer rests on the sidebar; the reveal's layers make it "leave". The peek stays, during and after.
 const first=revealMode(()=>{stage.dataset.page='general';},{from:'coding',to:'general'});
 await frame();await frame();
 peekSidebarLeave(mouse(x,y));
 const shown=await during();
 await first;
 must(shown==='in','(1) the floating sidebar did not stay through the reveal: '+shown);
 await wait(500);
 must(peek()==='in','(1) the floating sidebar closed after the reveal with the pointer still on it: '+peek());

 // (2) The pointer moves away during the reveal: the peek still stays through it, then closes right after.
 const second=revealMode(()=>{stage.dataset.page='coding';},{from:'general',to:'coding'});
 await frame();await frame();
 peekSidebarLeave(mouse(x,y));
 window.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:r.right+300,clientY:y,bubbles:true}));
 const shownAway=await during();
 await second;
 must(shownAway==='in','(2) the floating sidebar did not stay through the reveal: '+shownAway);
 must(peek()==='out','(2) the floating sidebar did not start closing as the reveal ended: '+peek());
 await wait(400);
 must(peek()==='','(2) the floating sidebar did not close after the pointer had left: '+peek());

 // (3) The pointer rests on the sidebar through a reveal (found there by its position), then moves away and no leave
 // event comes: the move itself closes the peek.
 peekButtonEnter(mouse(b.left+5,b.top+5,{currentTarget:button}));
 await wait(450);
 must(peek()==='in','(3) setup: the peek did not open again: '+peek());
 peekButtonLeave(mouse(x,y));
 peekSidebarEnter(mouse(x,y));
 const third=revealMode(()=>{stage.dataset.page='general';},{from:'coding',to:'general'});
 await frame();await frame();
 peekSidebarLeave(mouse(x,y));
 await during();
 await third;
 await wait(400);
 must(peek()==='in','(3) the floating sidebar closed after the reveal with the pointer still on it: '+peek());
 stage.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:r.right+300,clientY:y,bubbles:true}));
 await wait(260);
 must(peek()==='out'||peek()==='','(3) the floating sidebar stayed although the pointer moved away from it: '+peek());
 await wait(400);
 must(peek()==='','(3) the floating sidebar did not close after the pointer moved away: '+peek());
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error)+'</p>');}
`;

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"the floating sidebar stays through a mode reveal and closes afterwards only when the pointer has left",
	async () => {
		const root = mkdtempSync(join(resolve(process.env.MYHARNESS_TEMP_DIR ?? tmpdir()), "sidebar-peek-reveal-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			// The shell's own structure: a hidden sidebar column next to the conversation, and the button that peeks it.
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><body style="margin:0"><button id="show" class="icon-btn" style="position:fixed;left:8px;top:8px;z-index:200">show</button><div class="app" style="height:600px"><aside class="sidebar is-collapsed"><div class="sidebar-top"><button class="mode-switch">mode</button></div><div style="height:400px"></div></aside><div class="main"><div id="stage" data-page="coding" style="height:400px"></div></div></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(join(root, "test.js"), page);
			const { port } = await server.listen(0);
			const result = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/test/index.html`,
				readySelector: "#ready",
				label: "Sidebar peek through a mode reveal",
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
