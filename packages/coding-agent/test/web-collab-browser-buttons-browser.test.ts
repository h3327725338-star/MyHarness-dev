import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

/**
 * The browser's sizes as the user steps through them with the real buttons and keys of the mounted app, beside a
 * recording desktop host:
 *
 * - a website the Agent shows opens in collaboration mode with the conversation column at its narrowest, and the native
 *   view is asked for at exactly its box (`fit`), so the page shows whole without dragging the column;
 * - the collaboration button pressed again on a website, and Esc, put the browser away instead of the side panel;
 * - browser fullscreen ended by its button in the head, or by Esc after F11, steps down to collaboration mode;
 * - a website in the side panel (one the user opened there) is not asked for at its box only;
 * - on another tab the collaboration button still goes back to the side panel.
 */
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1")(
	"steps the browser between collaboration mode, fullscreen and put away with the real buttons",
	async () => {
		const installed = detectInstalledBrowsers();
		expect(installed.length).toBeGreaterThan(0);
		const root = join(process.env.MYHARNESS_TEMP_DIR!, `collab-buttons-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
			unattended: true,
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			const snap = {
				slot: "test",
				mode: "coding",
				cwd: "C:/fixture",
				session: { id: "chat", file: "test.jsonl", persisted: true },
				flags: {},
				active: false,
				model: { id: "test", name: "Test", input: ["text"] },
				dialogs: [],
				surface: { widgets: {}, statuses: {} },
				queue: { steering: [], followUp: [] },
				thinking: { levels: [], supported: false },
				trust: {},
				run: {},
				app: {},
				workspace: { name: "fixture", rootPath: "C:/fixture" },
			};
			server.route("GET", "/api/boot", () => ({ phase: "ready" }));
			server.route("GET", "/api/state", () => snap);
			server.route("GET", "/api/transcript", () => ({
				items: [{ kind: "user", text: "question", id: "u-1", ts: 1 }],
			}));
			server.route("GET", "/api/workspaces", () => ({ workspaces: [], sessions: [] }));
			server.route("GET", "/api/slots", () => ({ slots: [] }));
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("GET", "/api/resources", () => ({ commands: [] }));
			server.route("GET", "/api/git/status", () => ({ isRepository: false, gitAvailable: true }));
			server.route("GET", "/api/context", () => ({}));
			server.route("GET", "/api/sessions/unbound", () => ({ sessions: [] }));
			server.route("GET", "/api/sessions/archived", () => ({ sessions: [] }));
			server.route("GET", "/api/changes", () => ({ files: [], total: 0 }));
			server.route("GET", "/api/settings", () => ({}));
			server.route("GET", "/api/web-prefs", () => ({ prefs: null }));
			server.route("PUT", "/api/web-prefs", () => ({ ok: true }));
			server.route("POST", "/api/modes/state", () => ({ ok: true }));
			server.route("POST", "/api/sessions/touched", () => ({ ok: true }));
			server.route("POST", "/api/seen", () => ({ ok: true }));
			server.route("POST", "/api/prefs", () => ({ ok: true }));
			server.mount({ prefix: "/test/", directory: root });
			// The desktop bridge is there before the page's modules load, as in the app (window-controls.js reads it then). A
			// file of its own: the server's content policy runs no inline script.
			const bridge = `
window.__calls=[];
window.myHarnessDesktop={
	browser:async function(command){
		window.__calls.push(JSON.parse(JSON.stringify(command)));
		if(command.action==='bounds')return {ok:true,visible:!!command.rect};
		return {tabId:command.tabId,url:command.url||'https://example.com/',title:'Example Domain',loading:false,error:'',canGoBack:false,canGoForward:false,visible:false};
	},
	external:async function(){},
	onStatus:function(){return function(){}},
	openPath:async function(){return null},
	revealPath:async function(){return null},
	notify:async function(){},
	onNotificationClick:function(){return function(){}},
	windowControls:{state:async function(){return {maximized:true}},onState:function(){return function(){}},minimize:async function(){return {}},toggleMaximize:async function(){return {maximized:true}},close:async function(){return {}}},
};
`;
			writeFileSync(join(root, "bridge.js"), bridge);
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><div id="app"></div><script src="/test/bridge.js"></script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {App} from '/js/app.js';
import {actions} from '/js/actions.js';
import {boot,canSendToActive,chatColumnMin,setView,state} from '/js/store.js';
import {runWorkspaceCommand} from '/js/workspace-host.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms=6000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await wait(30)}return false};
const must=(ok,msg)=>{if(!ok)throw Error(msg)};
const app=()=>document.querySelector('.app');
const main=()=>document.querySelector('.app > .main');
const button=selector=>document.querySelector('.panel-head '+selector);
const bounds=()=>window.__calls.filter(call=>call.action==='bounds');
const lastBounds=()=>bounds().at(-1)||null;
const layout=()=>JSON.stringify({open:state.view.panelOpen,max:state.view.wsMax,full:!!state.view.browserFull,active:state.view.wsActive,chatW:state.view.chatW,sidebar:state.view.sidebarOpen,app:app()?.className,main:main()?.offsetWidth,bounds:lastBounds()});
// The layout morph has ended and the native view is back at a box.
const restful=()=>!document.documentElement.classList.contains('ws-morph');
const shownAt=async()=>until(()=>restful()&&lastBounds()?.rect);
const key=(name)=>window.dispatchEvent(new KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true}));
// A button of the panel head as drawn now: the store changes first, the page redraws a moment later.
const press=async(selector,title)=>{
 must(await until(()=>button(selector)&&(!title||button(selector).getAttribute('title')===title)),'the panel head has no '+selector+(title?' titled '+title:'')+': '+[...document.querySelectorAll('.panel-head button')].map(b=>b.className+'|'+b.title).join(' ; ')+' '+layout());
 button(selector).click();
};
const measured={};
let step='boot';
try {
 await boot();
 await until(()=>state.connected&&canSendToActive());
 render(h(App),document.getElementById('app'));
 await until(()=>main());
 setView({lang:'en',motion:'on',sidebarOpen:true,chatW:560});
 must(typeof document.startViewTransition==='function'&&document.visibilityState==='visible','no View Transition here: the morph is not exercised');
 must(await until(()=>document.querySelector('.window-controls')),'the window buttons of the desktop app are not drawn: '+JSON.stringify({bridge:!!window.myHarnessDesktop}));

 step='1';
 // 1. The Agent shows a website: collaboration mode, the conversation column at its narrowest, the view at its box.
 await runWorkspaceCommand({action:'open',tab:{type:'browser',url:'https://example.com/',muted:true,agent:true}});
 must(await shownAt(),'the shown website never got a box: '+layout());
 must(app().classList.contains('ws-max')&&state.view.wsMax,'the shown website is not in collaboration mode: '+layout());
 const narrowest=chatColumnMin();
 must(Math.abs(main().offsetWidth-narrowest)<=1,'the conversation column is not at its narrowest ('+narrowest+'): '+layout());
 must(lastBounds().fit===true,'the view of a website in collaboration mode is not asked for at exactly its box: '+layout());
 const box=lastBounds().rect;
 must(Math.abs(box.x+box.width-main().getBoundingClientRect().left)<=2,'the website does not reach the conversation column: '+layout());
 measured.window=innerWidth;measured.column=main().offsetWidth;measured.site=box.width;

 step='2';
 // 2. Its button again: the browser is put away, not shown in the side panel.
 await press('.panel-max','Close the browser (Esc)');
 must(await until(()=>!state.view.panelOpen&&restful()),'the collaboration button did not put the browser away: '+layout());
 must(!app().classList.contains('ws-max')&&!app().classList.contains('panel-open')&&lastBounds().rect===null,'the browser is still drawn after it was put away: '+layout());
 must(state.view.sidebarOpen===true,'the sidebar did not come back: '+layout());

 step='3';
 // 3. Shown again by the Agent, then Esc: put away too.
 await runWorkspaceCommand({action:'activate',tabId:state.view.wsTabs.find(tab=>tab.type==='browser').id});
 must(await shownAt()&&state.view.wsMax,'the website shown again is not in collaboration mode: '+layout());
 document.body.focus();
 key('Escape');
 must(await until(()=>!state.view.panelOpen&&restful()),'Esc in collaboration mode did not put the browser away: '+layout());

 step='4';
 // 4. Fullscreen from collaboration mode (the toolbar button), ended by the head's button: collaboration mode again.
 await runWorkspaceCommand({action:'activate',tabId:state.view.wsTabs.find(tab=>tab.type==='browser').id});
 must(await shownAt()&&state.view.wsMax,'setup: the website is not in collaboration mode: '+layout());
 setView({chatW:620});
 const full=document.querySelector('.panel button[aria-label="Fullscreen"]');
 must(full,'the toolbar has no fullscreen button');
 full.click();
 must(await until(()=>state.view.browserFull&&app().classList.contains('browser-full')),'fullscreen did not start: '+layout());
 await press('.panel-full');
 must(await until(()=>!state.view.browserFull&&state.view.wsMax&&Math.abs(main().offsetWidth-narrowest)<=1),'the exit button did not step down to collaboration mode with the narrowest column: '+layout());

 step='5';
 // 5. A website the user opens in the side panel is not asked for at its box only. F11 then Esc: collaboration mode,
 //    then the collaboration button puts it away and the sidebar comes back.
 await press('.panel-max','Close the browser (Esc)');
 must(await until(()=>!state.view.panelOpen&&restful()),'setup: the browser was not put away: '+layout());
 actions.openWorkspace({type:'browser',url:'https://example.org/'});
 must(await shownAt()&&!state.view.wsMax,'setup: the user website is not in the side panel: '+layout());
 must(lastBounds().fit!==true,'the side panel asked for the view at exactly its box: '+layout());
 key('F11');
 must(await until(()=>state.view.browserFull&&app().classList.contains('browser-full')),'F11 did not start fullscreen: '+layout());
 // The page's Esc follows the layout drawn on screen (its key handler is set up after the render).
 await wait(150);
 document.body.focus();
 key('Escape');
 must(await until(()=>!state.view.browserFull&&state.view.wsMax&&Math.abs(main().offsetWidth-narrowest)<=1),'Esc did not step fullscreen down to collaboration mode: '+layout());
 must(state.view.sidebarOpen===false,'the sidebar came back in collaboration mode: '+layout());
 await press('.panel-max','Close the browser (Esc)');
 must(await until(()=>!state.view.panelOpen&&restful()&&state.view.sidebarOpen===true),'the website was not put away with the sidebar back: '+layout());

 step='6';
 // 6. Another tab in collaboration mode: its button goes back to the side panel, as before.
 actions.openWorkspace({type:'changes'});
 await press('.panel-max','Maximize the workspace and keep chatting beside it');
 must(await until(()=>state.view.wsMax&&restful()),'Changes did not go to collaboration mode: '+layout());
 await press('.panel-max','Restore the workspace (Esc)');
 must(await until(()=>!state.view.wsMax&&state.view.panelOpen&&restful()),'Changes did not go back to the side panel: '+layout());
 document.body.insertAdjacentHTML('beforeend','<pre id="ready">passed '+JSON.stringify(measured)+'</pre>');
}catch(e){document.body.insertAdjacentHTML('beforeend','<pre id="ready">step '+step+': '+e.message+'</pre>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Collaboration buttons",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	120000,
);
