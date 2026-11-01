import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"shows only project search and tree and submits the explicit deletion choice in a real browser",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-artifact-browser-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		let choice: unknown;
		let removal: unknown;
		let result: any;
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			server.route("GET", "/api/artifacts", ({ url }) => ({
				entries: [
					{
						name: `report-${url.searchParams.get("scope")}.md`,
						path: "workspaces/w/sessions/s/artifacts/reports/report.md",
						workspaceId: "w",
						sessionId: "s",
						size: 12,
						conversationDeleted: true,
					},
				],
			}));
			server.route("GET", "/api/files/list", () => ({
				entries: [{ name: "AGENTS.md", path: "AGENTS.md", type: "file" }],
			}));
			server.route("GET", "/api/changes", () => ({ files: [] }));
			// The dialog opens at once and fills its counts from here; the delay shows that nothing moves when they arrive.
			server.route("GET", "/api/sessions/delete-impact", async ({ url }) => {
				await new Promise((resolve) => setTimeout(resolve, 300));
				// Only old versions are left of this chat's memories: they still go with it, so the switch is offered.
				if (url.searchParams.get("path") === "retired.jsonl")
					return {
						artifacts: { files: 0, bytes: 0 },
						history: { uploads: { files: 0, bytes: 0 }, toolResults: { files: 0, bytes: 0 } },
						memories: { owned: [], shared: 0, retired: 2 },
					};
				// Everything this chat made stays: the switch has nothing to do, and the list is the only way to see why.
				if (url.searchParams.get("path") === "kept.jsonl")
					return {
						artifacts: { files: 0, bytes: 0 },
						history: { uploads: { files: 0, bytes: 0 }, toolResults: { files: 0, bytes: 0 } },
						writtenFiles: {
							files: 0,
							bytes: 0,
							kept: 1,
							items: 1,
							list: [{ path: "C:\\project\\shot.png", bytes: 3, kept: "other-chat" }],
						},
						memories: { owned: [], shared: 0, retired: 0 },
					};
				// What this chat made in the project counts as its artifacts, a folder as one row; others stay, and the list says why.
				if (url.searchParams.get("path") === "elsewhere.jsonl")
					return {
						artifacts: { files: 0, bytes: 0 },
						history: { uploads: { files: 0, bytes: 0 }, toolResults: { files: 0, bytes: 0 } },
						writtenFiles: {
							files: 3,
							bytes: 9275,
							kept: 3,
							items: 7,
							incomplete: true,
							list: [
								{ path: "C:\\project\\pelican.html", bytes: 9268 },
								{ path: "C:\\project\\video", bytes: 7, files: 2, folder: true },
								{ path: "C:\\project\\edited.txt", bytes: 3, kept: "changed" },
								{ path: "C:\\project\\src\\main.ts", bytes: 3, kept: "committed" },
								{ path: "C:\\project\\shot.png", bytes: 3, kept: "other-chat" },
							],
						},
						memories: { owned: [], shared: 4, retired: 0 },
					};
				return {
					artifacts: { files: 3, bytes: 2048 },
					history: { uploads: { files: 1, bytes: 10 }, toolResults: { files: 0, bytes: 0 } },
					memories: { owned: [{ id: "workspace/note", name: "A note", scope: "workspace" }], shared: 2 },
				};
			});
			server.route("GET", "/api/workspaces/delete-impact", () => ({
				chats: 12,
				artifacts: { files: 3, bytes: 2048 },
				history: { uploads: { files: 1, bytes: 10 }, toolResults: { files: 0, bytes: 0 } },
				writtenFiles: { files: 1, bytes: 1024, kept: 0, list: [{ path: "C:\\project\\made.html", bytes: 1024 }] },
				memories: { owned: [{ id: "workspace/note", name: "A note", scope: "workspace" }], shared: 0, retired: 0 },
			}));
			server.route("POST", "/api/workspaces/remove", ({ body }) => {
				removal = body;
				return { ok: true };
			});
			server.route("POST", "/api/sessions/delete", ({ body }) => {
				choice = body;
				return { ok: true };
			});
			for (const route of [
				"/api/workspaces",
				"/api/slots",
				"/api/sessions/unbound",
				"/api/sessions/archived",
				"/api/transcript",
				"/api/resources",
			])
				server.route("GET", route, () => ({ workspaces: [], slots: [], sessions: [], items: [], commands: [] }));
			server.route("GET", "/api/state", () => ({ session: { id: "s" }, flags: {} }));
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return {};
			});
			server.route("POST", "/api/test-result", ({ body }) => {
				result = body;
				return {};
			});
			writeFileSync(
				join(root, "index.html"),
				'<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><img hidden src="/hold"><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {FilesPanel} from '/js/panel-files.js';
import {DeleteChatModal} from '/js/app.js';
import {actions,resolveConfirm} from '/js/actions.js';
import {state,set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms)); const app=document.getElementById('app');
try {
 setView({lang:'zh-CN'}); set({activeSlot:'slot-a',snap:{session:{id:'s'},lastRun:{runId:1}}});
 render(h(FilesPanel),app); await wait(150);
 if(app.querySelectorAll('.panel-toolbar').length!==1) throw Error('extra files toolbar');
 if(!app.querySelector('.panel-toolbar input') || !app.querySelector('[role="tree"]')?.textContent.includes('AGENTS.md')) throw Error('project search or tree missing');
 if([...app.querySelectorAll('button')].some(b=>['项目文件','产出文件','记忆'].includes(b.textContent))) throw Error('removed navigation returned');
 render(null,app);
 const cancelled=actions.deleteSession('chat.jsonl','Saved chat'); await wait(20);
 render(h(DeleteChatModal,{dialog:state.view.dialog}),app); await wait(40);
 const modal=()=>app.querySelector('.delete-chat');
 if(!modal()) throw Error('delete dialog did not open at once');
 const switches=()=>[...app.querySelectorAll('.del-row.opt .del-hit[role="switch"]')];
 if(switches().length!==2 || switches().some(row=>row.getAttribute('aria-checked')==='true')) throw Error('unsafe deletion default');
 if(!app.textContent.includes('正在统计')) throw Error('no counting state');
 const before=modal().offsetHeight;
 await wait(450);
 if(!app.textContent.includes('3 个文件') || !app.textContent.includes('1 条记忆') || !app.textContent.includes('另有 2 条')) throw Error('counts missing: '+app.textContent);
 if(Math.abs(modal().offsetHeight-before)>0.5) throw Error('dialog height moved when the counts arrived');
 if(!app.textContent.includes('保留 1 个附件')) throw Error('kept uploads not shown: '+app.textContent);
 // A real click anywhere on an option row (the drawn switch, the icon, the text) lands on that row's switch button.
 for(const row of app.querySelectorAll('.del-row.opt')) for(const part of ['.toggle','.del-icon','.del-detail']){
  const r=row.querySelector(part).getBoundingClientRect();
  const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
  if(hit!==row.querySelector('.del-hit')) throw Error('a click on '+part+' lands on '+(hit?.className||hit?.tagName)+', not the switch');
 }
 // The "show which" link sits inside the memory card: keys and clicks on it open the list and never flip the switch.
 const link=app.querySelector('.del-label .link-btn');
 link.focus();
 link.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 link.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}));
 link.click(); await wait(400);
 if(switches()[1].getAttribute('aria-checked')!=='false') throw Error('the show-which link turned on memory deletion');
 if(!app.querySelector('.del-list')?.textContent.includes('A note')) throw Error('show-which did not open the list');
 resolveConfirm(false); await cancelled;
 render(null,app);
 const retired=actions.deleteSession('retired.jsonl','Old chat'); await wait(20);
 render(h(DeleteChatModal,{dialog:state.view.dialog}),app); await wait(450);
 if(switches()[1].disabled || !app.textContent.includes('归档里的 2 个旧版本')) throw Error('archived-only memories not offered: '+app.textContent);
 resolveConfirm(false); await retired;
 render(null,app);
 const deletion=actions.deleteSession('chat.jsonl','Saved chat'); await wait(20);
 render(h(DeleteChatModal,{dialog:state.view.dialog}),app); await wait(450);
 const loaded=modal().offsetHeight;
 switches()[0].click(); await wait(20);
 if(switches()[0].getAttribute('aria-checked')!=='true') throw Error('artifacts switch did not turn on');
 if(Math.abs(modal().offsetHeight-loaded)>0.5) throw Error('dialog height moved when a switch flipped');
 if([...modal().querySelectorAll('.del-detail,.del-label,.del-pill,.btn')].some(el=>el.scrollWidth>el.clientWidth+1)) throw Error('clipped text in the dialog');
 [...app.querySelectorAll('button')].find(b=>b.textContent==='删除').click(); await deletion;
 await fetch('/api/test-result',{method:'POST',headers:{'Content-Type':'application/json','x-myharness-web':'1'},body:JSON.stringify({ok:true})}); document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(e) { await fetch('/api/test-result',{method:'POST',headers:{'Content-Type':'application/json','x-myharness-web':'1'},body:JSON.stringify({ok:false,error:String(e.stack||e)})}); document.body.insertAdjacentHTML('beforeend','<p id="ready">failed</p>'); }
`,
			);
			// A page gets a few seconds, so the dialogs of files and workspaces have their own.
			writeFileSync(
				join(root, "removal.html"),
				'<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><img hidden src="/hold"><script type="module" src="/test/removal.js"></script>',
			);
			writeFileSync(
				join(root, "removal.js"),
				`
import {h,render} from '/vendor/preact.js';
import {DeleteChatModal,RemoveWorkspaceModal} from '/js/app.js';
import {actions,resolveConfirm} from '/js/actions.js';
import {state,set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms)); const app=document.getElementById('app');
const modal=()=>app.querySelector('.delete-chat');
const switches=()=>[...app.querySelectorAll('.del-row.opt .del-hit[role="switch"]')];
try {
 setView({lang:'zh-CN'}); set({activeSlot:'slot-a',snap:{session:{id:'s'},lastRun:{runId:1}}});
 const keptOnly=actions.deleteSession('kept.jsonl','Kept chat'); await wait(20);
 render(h(DeleteChatModal,{dialog:state.view.dialog}),app); await wait(450);
 if(!switches()[0].disabled) throw Error('a switch with nothing to delete is on offer');
 const shownLink=app.querySelector('.del-label .link-btn'); const spot=shownLink.getBoundingClientRect();
 if(document.elementFromPoint(spot.left+spot.width/2,spot.top+spot.height/2)!==shownLink) throw Error('the list of what stays cannot be clicked in a dimmed row');
 resolveConfirm(false); await keptOnly; render(null,app);
 const elsewhere=actions.deleteSession('elsewhere.jsonl','Project chat'); await wait(20);
 render(h(DeleteChatModal,{dialog:state.view.dialog}),app); await wait(450);
 if(switches()[0].disabled) throw Error('a file the chat made in the project cannot be deleted');
 if(!switches()[1].disabled) throw Error('a memory switch with nothing to delete is on offer');
 if(!app.textContent.includes('3 个文件 · 9.1 KB · 另有 3 个文件保留') || app.textContent.includes('这次对话没有保存产出文件')) throw Error('the file is not counted as an artifact: '+app.textContent);
 if(!app.textContent.includes('4 条记忆涉及其他对话或整理') || app.textContent.includes('没有只属于这次对话的记忆')) throw Error('kept memories not shown: '+app.textContent);
 if([...modal().querySelectorAll('.del-detail')].some(el=>el.scrollWidth>el.clientWidth+1)) throw Error('clipped text in the elsewhere dialog');
 app.querySelector('.del-label .link-btn').click(); await wait(400);
 const listed=app.querySelector('.del-list')?.textContent||'';
 if(!listed.includes('pelican.html') || !listed.includes('edited.txt') || !listed.includes('后来被改过') || !listed.includes('main.ts') || !listed.includes('已在 Git 里') || !listed.includes('video/2 个文件') || !listed.includes('当时另一个对话也在工作') || !listed.includes('还有 2 个') || !listed.includes('这个文件夹太大')) throw Error('the file list does not say what goes and why: '+listed);
 if(switches()[0].getAttribute('aria-checked')!=='false') throw Error('the show-which link turned on artifact deletion');
 resolveConfirm(false); await elsewhere;
 render(null,app);
 set({workspaces:{...state.workspaces,list:[{id:'w1',name:'Project',rootPath:'C:/project'}]}});
 const removal=actions.removeWorkspace('w1','Project'); await wait(20);
 render(h(RemoveWorkspaceModal,{dialog:state.view.dialog}),app); await wait(40);
 if(switches().length!==3 || switches().some(row=>row.getAttribute('aria-checked')==='true')) throw Error('removing a workspace must delete nothing by default');
 await wait(450);
 if(!app.textContent.includes('12 个对话') || !app.textContent.includes('4 个文件') || !app.textContent.includes('1 条记忆')) throw Error('workspace counts missing: '+app.textContent);
 if(switches().some(row=>row.disabled)) throw Error('a workspace switch with something to delete is off');
 if([...modal().querySelectorAll('.del-detail,.del-label,.del-pill,.btn')].some(el=>el.scrollWidth>el.clientWidth+1)) throw Error('clipped text in the workspace dialog');
 switches()[0].click(); switches()[2].click(); await wait(20);
 [...app.querySelectorAll('button')].find(b=>b.textContent==='移除').click(); await removal;
 render(null,app);
 await fetch('/api/test-result',{method:'POST',headers:{'Content-Type':'application/json','x-myharness-web':'1'},body:JSON.stringify({ok:true})}); document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(e) { await fetch('/api/test-result',{method:'POST',headers:{'Content-Type':'application/json','x-myharness-web':'1'},body:JSON.stringify({ok:false,error:String(e.stack||e)})}); document.body.insertAdjacentHTML('beforeend','<p id="ready">failed</p>'); }
`,
			);
			const address = await server.listen(0);
			const open = (name: string) =>
				browser.solveChallenge({
					url: `http://127.0.0.1:${address.port}/test/${name}.html`,
					readySelector: "#ready",
					label: "Artifacts",
					isSolved: () => true,
				});
			const page = await open("index");
			expect(result, page.text).toEqual({ ok: true });
			result = undefined;
			const removalPage = await open("removal");
			expect(result, removalPage.text).toEqual({ ok: true });
			expect(choice).toEqual({ path: "chat.jsonl", deleteArtifacts: true, deleteMemory: false });
			expect(removal).toEqual({
				id: "w1",
				deleteChats: true,
				deleteArtifacts: false,
				deleteMemory: true,
				mode: "coding",
			});
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	30000,
);
