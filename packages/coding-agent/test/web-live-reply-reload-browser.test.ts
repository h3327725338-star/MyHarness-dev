import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// The server's transcript only holds what it has saved; the reply being streamed is saved when it ends. A transcript read
// in the middle of a run (a reconnect, the send check's recovery, a chat deleted elsewhere) used to wipe the live reply,
// and every later update of it was dropped because its live entry was gone: the answer stayed blank until a reload.
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1")(
	"keeps a streaming reply through a transcript reload, shows a reply whose start was missed, keeps a stopped reply in its turn",
	async () => {
		const installed = detectInstalledBrowsers();
		expect(installed.length).toBeGreaterThan(0);
		const root = join(process.env.MYHARNESS_TEMP_DIR!, `live-reply-reload-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
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
			const stored: Array<Record<string, unknown>> = [{ kind: "user", text: "question", id: "u-1", ts: 1 }];
			server.route("GET", "/api/boot", () => ({ phase: "ready" }));
			server.route("GET", "/api/state", () => snap);
			server.route("GET", "/api/transcript", () => ({ items: stored }));
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
			server.route("POST", "/api/modes/state", () => ({ ok: true }));
			server.route("POST", "/api/sessions/touched", () => ({ ok: true }));
			server.route("POST", "/api/seen", () => ({ ok: true }));
			server.route("POST", "/api/prefs", () => ({ ok: true }));
			// The page drives the run: each call pushes server events, or saves a message the way a finished one is saved.
			server.route("POST", "/api/test/emit", ({ body }) => {
				const input = body as {
					events?: Array<{ event: string; data: unknown }>;
					persist?: Record<string, unknown>;
				};
				if (input.persist) stored.push(input.persist);
				for (const entry of input.events ?? []) server.broadcast(entry.event, entry.data);
				return { ok: true };
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {App} from '/js/app.js';
import {boot,state,canSendToActive,refreshAll} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{for(let i=0;i<120;i++){if(fn())return true;await wait(50)}return false};
const emit=(events,persist)=>fetch('/api/test/emit',{method:'POST',headers:{'content-type':'application/json','x-myharness-web':'1'},body:JSON.stringify({events,persist})});
const reply=(text,id)=>({kind:'assistant',ts:Date.now(),blocks:[{type:'text',text}],stopReason:'stop',...(id?{id}:{})});
const shown=text=>(document.querySelector('.transcript')?.textContent||'').split(text).length-1;
const check=async(label,fn)=>{if(!(await until(fn)))throw Error(label)};
try {
 await boot();
 await until(()=>state.connected&&canSendToActive());
 render(h(App),document.getElementById('app'));
 await check('question not drawn',()=>shown('question')===1);
 // 1. A reply streams, the transcript is read again mid-run, and the reply goes on.
 await emit([{event:'message_start',data:{slot:'test',liveId:'live-1',item:reply('first-part')}}]);
 await check('streamed reply not drawn',()=>shown('first-part')===1);
 await refreshAll();
 await wait(200);
 if(shown('first-part')!==1) throw Error('reload wiped the streaming reply');
 await emit([{event:'message_update',data:{slot:'test',liveId:'live-1',item:reply('first-part grows')}}]);
 await check('update after reload dropped',()=>shown('first-part grows')===1);
 await emit([{event:'message_end',data:{slot:'test',liveId:'live-1',item:reply('first-done')}}]);
 await check('finished reply not drawn',()=>shown('first-done')===1);
 // Saved by the server: the next read shows that copy only, never the live one next to it.
 await emit([], reply('first-done','a-1'));
 await refreshAll();
 await wait(300);
 if(shown('first-done')!==1) throw Error('saved reply drawn '+shown('first-done')+' times after reload');
 // 2. A reply whose start never reached the page (the stream reconnected in between) still shows, once.
 await emit([{event:'message_update',data:{slot:'test',liveId:'live-2',item:reply('second-part')}}]);
 await check('reply with a missed start not drawn',()=>shown('second-part')===1);
 await emit([{event:'message_end',data:{slot:'test',liveId:'live-2',item:reply('second-done')}}]);
 await check('missed-start reply not finished',()=>shown('second-done')===1&&shown('second-part')===0);
 // 3. A message_end that arrives after a read already brought the saved copy adds nothing.
 await emit([], reply('third-done','a-3'));
 await refreshAll();
 await check('saved third reply not drawn',()=>shown('third-done')===1);
 await emit([{event:'message_end',data:{slot:'test',liveId:'live-3',item:reply('third-done')}}]);
 await wait(300);
 if(shown('third-done')!==1) throw Error('late message_end duplicated a saved reply');
 // 4. A reply stopped before any output has no content to match its saved copy by. Its live copy was carried across
 // every read and drawn at the tail, so the next turn showed "Cancelled" under its complete answer.
 await emit([], reply('second-done','a-2'));
 const empty=(ts,extra)=>({kind:'assistant',ts,blocks:[],stopReason:'aborted',...extra});
 const emptyCount=()=>state.items.filter(i=>i.kind==='assistant'&&!(i.blocks||[]).length).length;
 const cancelledIn=text=>[...document.querySelectorAll('.transcript section.turn')].filter(s=>(s.querySelector('.user-bubble')?.textContent||'').includes(text)).reduce((n,s)=>n+s.querySelectorAll('.banner.o-cancelled').length,0);
 const stopUser={kind:'user',text:'stop-me',id:'u-4',ts:Date.now()};
 await emit([{event:'message_start',data:{slot:'test',item:stopUser}}],stopUser);
 await emit([{event:'message_start',data:{slot:'test',liveId:'live-4',item:{kind:'assistant',ts:stopUser.ts+10,blocks:[]}}}]);
 const stoppedAt=Date.now();
 // Saved first, then reported, the way the server does it.
 await emit([{event:'message_end',data:{slot:'test',liveId:'live-4',item:empty(stopUser.ts+10),endedAt:stoppedAt}}],empty(stoppedAt+5,{id:'a-4'}));
 await check('stopped turn shows no Cancelled card',()=>cancelledIn('stop-me')===1);
 await emit([], {kind:'user',text:'next-question',id:'u-5',ts:stoppedAt+10000});
 await emit([], {...reply('next-answer','a-5'),ts:stoppedAt+11000});
 await refreshAll();
 await check('next turn not drawn',()=>shown('next-answer')===1);
 await wait(300);
 if(cancelledIn('stop-me')!==1||cancelledIn('next-question')!==0) throw Error('stopped reply moved on a reload: Cancelled cards '+cancelledIn('stop-me')+' / '+cancelledIn('next-question'));
 if(emptyCount()!==1) throw Error('stopped reply kept twice: '+emptyCount());
 // A late message_end of an empty reply whose saved copy a read already brought adds no second copy.
 const failedAt=Date.now();
 await emit([], empty(failedAt,{id:'a-6',stopReason:'error'}));
 await refreshAll();
 await check('saved empty reply not loaded',()=>emptyCount()===2);
 await emit([{event:'message_end',data:{slot:'test',liveId:'live-6',item:empty(failedAt-50,{stopReason:'error'}),endedAt:failedAt-3}}]);
 await wait(300);
 if(emptyCount()!==2) throw Error('late message_end duplicated a saved empty reply: '+emptyCount());
 document.body.insertAdjacentHTML('beforeend','<pre id="ready">passed</pre>');
}catch(e){document.body.insertAdjacentHTML('beforeend','<pre id="ready">'+e.message+'</pre>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Live reply reload",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
		}
	},
	90000,
);
