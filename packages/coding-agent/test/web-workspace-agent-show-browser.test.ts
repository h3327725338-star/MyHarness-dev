import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * A website the Agent shows the user opens in collaboration mode (the page beside the conversation) in one step, never
 * drawn in the narrow side panel first and never in browser fullscreen, with the conversation column at its narrowest;
 * tabs it opens in the background never open the panel, and files and links the user clicked keep the layout as it was.
 * Collaboration mode pressed again on a website puts the browser away; browser fullscreen ended by the user steps down to
 * collaboration mode, while a site's own full screen goes back to where it started. A chat that is not on screen gets
 * collaboration mode for when it is opened. The shipped page modules run unchanged in a headless browser; only the
 * server's API routes are stubs.
 */
it.skipIf(!installed.length)(
	"opens a website the Agent shows in collaboration mode in one step, and steps the browser's sizes down without the side panel",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-agent-show-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
			// Runs in the plain unit suite too: headless, never a window pulled to the front.
			unattended: true,
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/files/list", () => ({ entries: [] }));
			server.route("GET", "/api/files/read", () => ({ kind: "text", content: "", size: 0 }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {actions} from '/js/actions.js';
import {chatColumnMin,setView,state,storedPanel,subscribe} from '/js/store.js';
import {normalizeWorkspaceTabs} from '/js/workspace-model.js';
import {runWorkspaceCommand} from '/js/workspace-host.js';
const check=(ok,msg)=>{if(!ok)throw new Error(msg)};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Leaving collaboration mode runs as a layout morph (a View Transition), which changes the store a moment later.
const settle=async(fn)=>{for(let i=0;i<60&&!fn();i++)await wait(50)};
const layout=()=>JSON.stringify({panelOpen:state.view.panelOpen,wsMax:state.view.wsMax,browserFull:!!state.view.browserFull,sidebar:state.view.sidebarOpen,active:state.view.wsActive,chatW:state.view.chatW});
// The width a chat without one of its own starts from: the last one the user dragged.
const savedChatW=()=>JSON.parse(localStorage.getItem('myharness.web.prefs')||'{}').chatW;
// Every state the page publishes: a website the Agent shows was drawn in the side panel for a moment before
// collaboration mode came in. None of them may show it there now.
const sidePanel=[];
subscribe(()=>{const tab=state.view.wsTabs.find(item=>item.id===state.view.wsActive);if(tab&&tab.agent&&state.view.panelOpen&&!state.view.wsMax&&!state.view.browserFull)sidePanel.push(layout());});
try {
	setView({motion:'on'});
	check(typeof document.startViewTransition==='function'&&document.visibilityState==='visible','no View Transition here: the one-step switch is not exercised');

	// A new chat has nothing open. The Agent works in a tab of its own in the background: the panel stays closed, and the
	// tab is what it shows when the user opens it.
	setView({sidebarOpen:true,panelOpen:false,wsMax:false,wsTabs:[],wsActive:null,wsClosed:[]});
	await runWorkspaceCommand({action:'open',background:true,tab:{type:'browser',url:'https://example.com/first',id:'browser:first',agent:true}});
	await wait(300);
	check(state.view.panelOpen===false&&state.view.wsMax===false,'a background tab in a new chat opened the panel: '+layout());
	check(state.view.wsActive==='browser:first','a background tab in a new chat is not the tab the panel opens with: '+layout());

	setView({sidebarOpen:true,panelOpen:false,wsMax:false,wsTabs:normalizeWorkspaceTabs(null,'changes'),wsActive:'changes',wsClosed:[]});
	// The Agent works in its own tab in the background: nothing opens.
	await runWorkspaceCommand({action:'open',background:true,tab:{type:'browser',url:'https://example.com/work',id:'browser:work',agent:true}});
	await wait(500);
	check(state.view.panelOpen===false&&state.view.wsMax===false,'a background tab changed the layout: '+layout());

	// A file the Agent opens keeps the side panel.
	await runWorkspaceCommand({action:'open',tab:{type:'file',path:'notes.md'}});
	await wait(500);
	check(state.view.panelOpen===true&&state.view.wsMax===false,'a file opened collaboration mode: '+layout());

	// A link the user clicked in a preview is theirs: the side panel, as before.
	await runWorkspaceCommand({action:'open',link:true,tab:{type:'browser',url:'https://example.org/'}});
	await wait(500);
	check(state.view.wsMax===false,'a clicked link opened collaboration mode: '+layout());

	// The Agent brings its tab to the front (to show it, or for the user to sign in): collaboration mode in one step, the
	// conversation column at its narrowest. The width the user dragged last stays the one other chats start from.
	setView({chatW:560});
	await runWorkspaceCommand({action:'activate',tabId:'browser:work'});
	check(state.view.wsActive==='browser:work','the tab did not come to the front: '+layout());
	check(state.view.wsMax===true&&state.view.panelOpen===true,'the shown website is not in collaboration mode: '+layout());
	check(sidePanel.length===0,'the shown website was drawn in the side panel first: '+sidePanel.join(' then '));
	check(!state.view.browserFull,'the shown website went to browser fullscreen: '+layout());
	check(state.view.wsChatHidden===false,'the conversation column is hidden: '+layout());
	check(state.view.chatW===chatColumnMin(),'the conversation column did not start at its narrowest: '+layout());
	check(savedChatW()===560,'the narrowest column replaced the width the user dragged: '+savedChatW());

	// Pressed again (or Esc), collaboration mode on a website puts the browser away instead of going back to the side
	// panel; the sidebar it hid comes back.
	actions.restoreWorkspace();
	await settle(()=>!state.view.panelOpen);
	check(state.view.panelOpen===false&&state.view.wsMax===false&&state.view.sidebarOpen===true,'collaboration mode on a website did not put the browser away: '+layout());

	// The Agent opens a website in front from the closed panel: collaboration mode again, in one step.
	await runWorkspaceCommand({action:'open',tab:{type:'browser',url:'https://example.net/show',id:'browser:show',agent:true}});
	check(state.view.wsMax===true&&state.view.wsActive==='browser:show','a website opened in front is not in collaboration mode: '+layout());
	check(sidePanel.length===0,'a website opened in front was drawn in the side panel first: '+sidePanel.join(' then '));

	// ... and from the side panel showing another tab.
	actions.restoreWorkspace();
	await settle(()=>!state.view.panelOpen);
	actions.openWorkspace({type:'changes'});
	await wait(100);
	check(state.view.panelOpen===true&&state.view.wsMax===false,'setup: the side panel is not open: '+layout());
	await runWorkspaceCommand({action:'activate',tabId:'browser:show'});
	check(state.view.wsMax===true&&state.view.wsActive==='browser:show'&&sidePanel.length===0,'from the side panel the website did not come in one step: '+layout()+' '+sidePanel.join(' then '));

	// Collaboration mode on another tab goes back to the side panel, as before.
	actions.activateWorkspaceTab('changes');
	actions.restoreWorkspace();
	await settle(()=>!state.view.wsMax);
	check(state.view.panelOpen===true&&state.view.wsMax===false,'collaboration mode on Changes did not go back to the side panel: '+layout());

	// Browser fullscreen ended by the user steps down to collaboration mode: the page stays, the conversation is the column
	// on its right at its narrowest; never the side panel. From the side panel (a website the user opened there):
	actions.openWorkspace({type:'browser',url:'https://example.org/mine',id:'browser:mine'});
	await wait(50);
	check(state.view.panelOpen===true&&state.view.wsMax===false&&state.view.sidebarOpen===true,'setup: the user\\'s website is not in the side panel: '+layout());
	actions.toggleBrowserFull(true);
	check(state.view.browserFull===true&&state.view.sidebarOpen===false,'fullscreen did not start: '+layout());
	actions.toggleBrowserFull(false);
	check(state.view.browserFull===false&&state.view.wsMax===true&&state.view.panelOpen===true,'leaving fullscreen did not land in collaboration mode: '+layout());
	check(state.view.chatW===chatColumnMin()&&state.view.sidebarOpen===false,'after fullscreen the conversation column is not at its narrowest, or the sidebar is back: '+layout());
	actions.restoreWorkspace();
	await settle(()=>!state.view.panelOpen);
	check(state.view.panelOpen===false&&state.view.sidebarOpen===true,'the sidebar of the plain layout did not come back: '+layout());

	// From collaboration mode with a wider conversation column: back to it at its narrowest.
	await runWorkspaceCommand({action:'activate',tabId:'browser:show'});
	setView({chatW:600});
	actions.toggleBrowserFull(true);
	actions.toggleBrowserFull(false);
	check(state.view.wsMax===true&&!state.view.browserFull&&state.view.chatW===chatColumnMin(),'fullscreen did not step down to collaboration mode with the narrowest column: '+layout());
	check(savedChatW()===600,'stepping down replaced the width the user dragged: '+savedChatW());

	// A site's own full screen (a video's button) ends where it started: here the side panel.
	actions.restoreWorkspace();
	await settle(()=>!state.view.panelOpen);
	actions.activateWorkspaceTab('browser:mine');
	await wait(50);
	check(state.view.panelOpen===true&&state.view.wsMax===false,'setup: the user\\'s website is not in the side panel: '+layout());
	actions.toggleBrowserFull(true,{bySite:true});
	actions.toggleBrowserFull(false,{bySite:true});
	check(state.view.browserFull===false&&state.view.wsMax===false&&state.view.panelOpen===true,'a site ending its full screen did not go back to the side panel: '+layout());
	// Fullscreen that ends because the panel closed (app.js) leaves the panel closed.
	actions.toggleBrowserFull(true);
	setView({panelOpen:false});
	actions.toggleBrowserFull(false);
	check(state.view.panelOpen===false&&state.view.wsMax===false&&!state.view.browserFull,'closing the panel in fullscreen opened collaboration mode: '+layout());

	// A chat that is not on screen: a background tab never opens its panel; a website shown in front waits there in
	// collaboration mode with the conversation column at its narrowest.
	await runWorkspaceCommand({action:'open',sessionId:'other-chat',background:true,tab:{type:'browser',url:'https://example.com/bg',id:'browser:bg',agent:true}});
	check(storedPanel('other-chat').wsMax!==true&&storedPanel('other-chat').panelOpen!==true,'a background tab of another chat opened its panel: '+JSON.stringify(storedPanel('other-chat')));
	await runWorkspaceCommand({action:'activate',sessionId:'other-chat',tabId:'browser:bg'});
	check(storedPanel('other-chat').wsMax===true&&storedPanel('other-chat').panelOpen===true&&storedPanel('other-chat').chatW===chatColumnMin(),'a website shown in another chat does not wait in collaboration mode: '+JSON.stringify(storedPanel('other-chat')));
	document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Agent shows a website",
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
