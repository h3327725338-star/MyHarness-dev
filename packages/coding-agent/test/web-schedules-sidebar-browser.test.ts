import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"keeps the chats of scheduled tasks in their own folded group and opens the page over the chat with motion",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-schedules-sidebar-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		const now = Date.now();
		const chat = (id: string, modified: number, scheduled = false) => ({
			path: `C:/fixture/${id}.jsonl`,
			id,
			name: `Chat ${id}`,
			modified,
			firstMessage: id,
			messageCount: 2,
			scheduled,
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/workspaces", () => ({ workspaces: [] }));
			// The list of chats without a workspace holds the task's chats too; the sidebar leaves them out there.
			server.route("GET", "/api/sessions/unbound", () => ({
				sessions: [chat("mine", now - 1000), chat("task1", now - 2000, true), chat("task2", now - 3000, true)],
			}));
			server.route("GET", "/api/sessions/scheduled", () => ({
				sessions: [chat("task1", now - 2000, true), chat("task2", now - 3000, true)],
			}));
			server.route("GET", "/api/sessions/archived", () => ({ sessions: [] }));
			server.route("GET", "/api/slots", () => ({
				slots: [
					{ slot: "s1", sessionFile: "C:/fixture/mine.jsonl", sessionId: "mine", unbound: true, hasContent: true },
				],
			}));
			server.route("GET", "/api/schedules", () => ({
				schedules: [],
				firing: true,
				device: { id: "d", name: "This computer" },
				devices: [],
				notices: [],
			}));
			server.route("POST", "/api/seen", () => ({ ok: true }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/overlays.css"><div id="side" class="sidebar-host" style="width:280px;height:700px;display:flex;flex-direction:column"></div><main id="main" style="position:relative;width:800px;height:600px"></main><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Sidebar} from '/js/sidebar.js';
import {SchedulesPageHost} from '/js/schedules.js';
import {loadScheduled,loadUnbound,set,setView,state} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const rows=()=>[...document.querySelectorAll('#side .chat-row')].filter(r=>!r.closest('.collapse:not(.open)')).map(r=>r.title).join(',');
const groupRow=()=>[...document.querySelectorAll('#side .ws-row')].find(r=>r.querySelector('.ws-count'));
const page=()=>document.querySelector('.schedules-page');
const nav=()=>[...document.querySelectorAll('#side .nav-btn')].find(b=>b.textContent.includes('Scheduled tasks'));
const key=(k)=>window.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
try {
 document.documentElement.dataset.motion='on';
 setView({lang:'en',motion:'on',expanded:{'<general>':true}});
 set({activeSlot:'s1',slots:[{slot:'s1',sessionFile:'C:/fixture/mine.jsonl',sessionId:'mine',unbound:true,hasContent:true}]});
 await loadUnbound();
 render(h('div',null,h(Sidebar)),document.getElementById('side'));
 render(h(SchedulesPageHost),document.getElementById('main'));
 await wait(100);
 // Before the list of the group is there: no group, and the task's chats are not in the other group either.
 if(groupRow()) throw Error('group shown without a list');
 if(rows()!=='Chat mine') throw Error('task chats in Default: '+rows());
 await loadScheduled(); await wait(30);
 // The group arrives with the fold motion and stays folded.
 const fold=groupRow().closest('.collapse');
 if(!fold||!fold.parentElement) throw Error('group not in a fold');
 await wait(400);
 if(groupRow().querySelector('.ws-count').textContent!=='2') throw Error('count '+groupRow().querySelector('.ws-count').textContent);
 if(groupRow().getAttribute('aria-expanded')!=='false') throw Error('group not folded by default');
 if(groupRow().querySelector('.actions button')) throw Error('group has actions');
 if(rows()!=='Chat mine') throw Error('folded group shows rows: '+rows());
 groupRow().click(); await wait(400);
 if(rows()!=='Chat mine,Chat task1,Chat task2') throw Error('open group rows: '+rows());
 groupRow().click(); await wait(400);
 // Open: mounted first and shown one painted frame later, so the opacity really moves.
 const current=[...document.querySelectorAll('#side .chat-row')].find(r=>r.title==='Chat mine');
 current.classList.add('current');
 nav().click();
 await wait(0);
 if(!page()) throw Error('page not mounted');
 if(page().parentElement!==document.getElementById('main')) throw Error('page not over the chat');
 if(!nav().classList.contains('on')) throw Error('nav not highlighted');
 const starts=Number(getComputedStyle(page()).opacity);
 await wait(60);
 if(starts>0.5) throw Error('page did not start faded: '+starts);
 if(!page().getAnimations().length && Number(getComputedStyle(page()).opacity)<1) throw Error('page stuck');
 await wait(400);
 if(Number(getComputedStyle(page()).opacity)!==1) throw Error('page not shown');
 if(page().querySelector('.set-card-head strong')) throw Error('title shown twice');
 if(!page().querySelector('.sources-title').textContent.includes('Scheduled tasks')) throw Error('header title');
 if(document.activeElement?.getAttribute('aria-label')!=='Back') throw Error('focus not on Back');
 // Esc goes back, with the leave motion; while typing in a field it does not.
 const field=document.createElement('input'); page().appendChild(field); field.focus();
 field.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 await wait(30);
 if(!state.view.schedulesPage) throw Error('Esc in a field closed the page');
 field.remove();
 document.body.focus();
 key('Escape'); await wait(0);
 if(state.view.schedulesPage) throw Error('Esc did not close');
 if(!page()) throw Error('page gone without leaving');
 await wait(300);
 if(page()) throw Error('page not removed');
 if(nav().classList.contains('on')) throw Error('nav stays highlighted');
 // The button toggles.
 nav().click(); await wait(300);
 if(!page()) throw Error('button did not open');
 nav().click(); await wait(300);
 if(page()) throw Error('button did not close');
 // A click on any chat row closes the page.
 nav().click(); await wait(300);
 [...document.querySelectorAll('#side .chat-row')].find(r=>r.title==='Chat mine').click(); await wait(300);
 if(page()||state.view.schedulesPage) throw Error('row did not close the page');
 // A switch to another chat closes it too.
 nav().click(); await wait(300);
 set({activeSlot:'s2'}); await wait(300);
 if(page()||state.view.schedulesPage) throw Error('switch did not close the page');
 // A chat a task just started, not saved yet, is in the group from its slot, and its unread dot is the group's.
 set({activeSlot:'s1',slots:[{slot:'s1',sessionFile:'C:/fixture/mine.jsonl',sessionId:'mine',unbound:true,hasContent:true},{slot:'s3',sessionFile:'C:/fixture/fresh.jsonl',sessionId:'fresh',unbound:true,hasContent:true,firstMessage:'run',name:'Fresh run',scheduled:true,unread:true}]});
 await wait(400);
 if(groupRow().querySelector('.ws-count').textContent!=='3') throw Error('unsaved chat not counted');
 if(!groupRow().querySelector('.ws-unread')) throw Error('no unread dot on the group');
 const general=[...document.querySelectorAll('#side .ws-row')].find(r=>r!==groupRow());
 if(general.querySelector('.ws-unread')) throw Error('unread dot on Default');
 if(rows().includes('Fresh run')) throw Error('fresh run outside its folded group: '+rows());
 // The chat on screen is a task's chat: its group opens by itself.
 set({opening:null,snap:{session:{file:'C:/fixture/task1.jsonl'}}}); await wait(400);
 if(groupRow().getAttribute('aria-expanded')!=='true') throw Error('group did not open for the chat on screen');
 document.body.insertAdjacentHTML('beforeend','<div id="ready">passed</div>');
} catch(error){ const box=document.createElement('div'); box.id='ready'; box.textContent='failed: '+error.message; document.body.append(box); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Scheduled tasks in the sidebar",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	60000,
);
