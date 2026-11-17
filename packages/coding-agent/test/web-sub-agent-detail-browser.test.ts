import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// An opened sub-task of a dispatch, in parts that never run together: the task (one line), the process (all its tool
// calls folded into one line), the report it handed in (Markdown rendered) and its reply lines (folded). The dispatch row
// names its tasks by their short names, the hand-in step says so in words, the opened task never scrolls on its own, and
// what the user opened stays open when the turn ends and the transcript draws the row again.
const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"shows an opened sub-agent as task, folded process, report and folded reply",
	async () => {
		// Absolute: a relative browser profile makes Chrome pop up a "cannot create data directory" box on the desktop.
		const base = resolve(process.env.MYHARNESS_TEMP_DIR || tmpdir());
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "sub-agent-detail-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><div id="app" style="width:760px"></div><img src="/hold" hidden><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {setLang} from '/js/lang.js';
import {set,setView} from '/js/store.js';
const app=document.getElementById('app'),wait=ms=>new Promise(r=>setTimeout(r,ms));
const need=(cond,msg)=>{if(!cond) throw Error(msg);};
const $=(sel,root=app)=>root.querySelector(sel), $$=(sel,root=app)=>[...root.querySelectorAll(sel)];
const text=el=>(el?.textContent||'').replace(/\\s+/g,' ').trim();
const longPrompt='Read-only look at packages/ai/: list the top folders under src and one line for each, from the real files. '+'Do not change any file. '.repeat(6);
const traces=[
 {toolCallId:'t1',toolName:'ls',args:{path:'packages/ai/src'},status:'completed',durationMs:20,resultSummary:'api auth'},
 {toolCallId:'t2',toolName:'read',args:{path:'packages/ai/src/README.md',offset:1,limit:60},status:'completed',durationMs:30,resultSummary:'# ai'},
 {toolCallId:'t3',toolName:'submit_report',args:{report:'Read-only look at packages/ai/src: SUMMARY AS ARGUMENT'},status:'completed',durationMs:5}];
const report='Top folders of **packages/ai/src**:\\n\\n- \`src/api/\` — one stream per protocol\\n- \`src/auth/\` — credentials';
const doneTask={description:'AI Provider overview',prompt:longPrompt,status:'completed',toolUseCount:3,durationMs:25000,reportSubmission:'tool',output:report,
 findings:['README matches the files, so:','- \`src/api/\` — one stream per protocol','- \`src/auth/\` — credentials'],transcript:traces};
const otherTask={description:'Agent Core overview',prompt:'Read-only look at packages/agent/',status:'completed',toolUseCount:1,durationMs:8000,reportSubmission:'tool',output:'',findings:['- \`packages/agent/src\` — the loop'],transcript:[traces[0]]};
const runningTask={...doneTask,status:'running',output:'',findings:[],reportSubmission:undefined,transcript:[traces[0],{...traces[1],status:'running',durationMs:undefined}]};
const args={tasks:[{description:'Agent Core overview',prompt:'Read-only look at packages/agent/'},{description:'AI Provider overview',prompt:longPrompt}]};
const call={kind:'assistant',id:'a1',ts:2,blocks:[{type:'toolCall',id:'c1',name:'agent',args}],stopReason:'toolUse'};
const user={kind:'user',id:'u1',ts:1,text:'look',images:[]};
const live={completed:1,total:2,model:'z-ai/glm-5.3-flash',results:[otherTask,runningTask]};
const done={completed:2,total:2,model:'z-ai/glm-5.3-flash',results:[otherTask,doneTask]};
try {
 setView({processDefault:'expanded'});
 // 1. while it runs: the process line says what it does now, and there is no report part yet
 set({items:[user,call],snap:{active:true,cwd:'C:/test',flags:{},session:{id:'s'},run:{startedAt:Date.now()}},toolRuns:{c1:{status:'running',partialDetails:live}},runs:{},dialogs:[],userBash:{},userBashOrder:[]});
 render(h(Transcript,{}),app);await wait(500);
 const card=()=>$('.action[data-tool-call="c1"]');
 need(card(),'the dispatch row was not drawn');
 const title=text($('.action-row .action-text',card()));
 need(title.includes('2 tasks: Agent Core overview · AI Provider overview'),'the title does not name the tasks by their short names: '+title);
 need(!title.includes('Read-only look'),'the title still carries the prompts: '+title);
 const task=()=>$$('.sub-task',card())[1];
 $('.action-row',task()).click();await wait(450);
 need($('.sub-detail',task()),'the running task did not open');
 const proc=()=>$('.sa-sec-process',task());
 need(proc()&&text($('.sa-sec-text',proc())).includes('Reading packages/ai/src/README.md'),'the running process line does not say what it does now: '+text(proc()));
 need($('.sa-sec-text.shimmer-text',proc()),'the running process line is not live');
 need(!$('.sa-sec-report',task()),'a running task without a report shows a report part');
 need($('.sa-sec-row',proc()).getAttribute('aria-expanded')==='false'&&!$('.sa-steps',proc()),'the process does not start folded');
 $('.sa-sec-row',proc()).click();await wait(450);
 need($$('.sa-steps .action',proc()).length===2,'the opened process does not list the tool calls');

 // 2. the turn ends: the call's result arrives, the transcript draws the row again; what was opened stays open
 set({items:[user,call,{kind:'toolResult',ts:3,toolCallId:'c1',toolName:'agent',text:'done',details:done,isError:false},{kind:'assistant',id:'a2',ts:4,blocks:[{type:'text',text:'final'}],stopReason:'stop',final:true}],snap:{active:false,cwd:'C:/test',flags:{},session:{id:'s'}},toolRuns:{}});
 await wait(700);
 need(card()&&task(),'the finished dispatch row was not drawn');
 need($('.sub-detail',task()),'the opened task closed when the turn ended');
 need($('.sa-sec-row',proc()).getAttribute('aria-expanded')==='true'&&$$('.sa-steps .action',proc()).length===3,'the opened process closed when the turn ended');

 // 3. the parts, in order, none running into the next
 const names=$$('.sa-sec',task()).map(el=>[...el.classList].find(c=>c.startsWith('sa-sec-')));
 need(names.join()==='sa-sec-task,sa-sec-process,sa-sec-report,sa-sec-reply','parts out of order: '+names.join());
 const taskPart=$('.sa-sec-task',task());
 need(getComputedStyle($('.sa-sec-text',taskPart)).whiteSpace==='nowrap','the task line is not one line');
 need(!$('.sa-prompt',taskPart),'the whole prompt shows before it is opened');
 $('.sa-sec-row',taskPart).click();await wait(450);
 need(text($('.sa-prompt',taskPart))===text({textContent:longPrompt}),'the opened task does not show the whole prompt');
 need(text($('.sa-sec-text',proc())).includes('3 tool calls')&&text($('.sa-sec-text',proc())).includes('Handed in the report'),'the finished process line: '+text($('.sa-sec-text',proc())));

 // 4. the hand-in step is said in words, without the tool name or the report summary
 const handIn=text($$('.sa-steps .action',proc())[2]);
 need(handIn.includes('Handed in the report')&&handIn.includes('completed'),'the hand-in step: '+handIn);
 need(!handIn.includes('submit_report')&&!handIn.includes('SUMMARY AS ARGUMENT'),'the hand-in step shows the tool name or the summary: '+handIn);

 // 5. the report: how it ended, then the Markdown it handed in, rendered
 const rep=$('.sa-sec-report',task());
 need(text($('.sa-verdict',rep)).includes('completed'),'the report part does not say how it ended: '+text(rep));
 need($$('.sa-report li',rep).length===2&&$('.sa-report li code',rep)&&$('.sa-report strong',rep),'the report Markdown is not rendered');
 need(!/^-/.test(text($('.sa-report li',rep))),'a report item still starts with a raw dash');

 // 6. the reply: folded, opens to the reply lines rendered as one Markdown text
 const reply=$('.sa-sec-reply',task());
 need($('.sa-sec-row',reply).getAttribute('aria-expanded')==='false'&&!$('.sa-reply',reply),'the reply does not start folded');
 $('.sa-sec-row',reply).click();await wait(450);
 need($$('.sa-reply li',reply).length===2&&$('.sa-reply li code',reply),'the reply lines are not rendered as Markdown');
 need(!$$('.sa-reply li',reply).some(li=>/^-/.test(text(li))),'a reply item still starts with a raw dash');
 need(!text(card()).includes('Findings'),'the old Findings list is still drawn');

 // 7. no scroller of its own: the opened task grows with what it holds
 const ds=getComputedStyle($('.sub-detail',task()));
 need(ds.maxHeight==='none'&&ds.overflowY==='visible','the opened task scrolls on its own: '+ds.maxHeight+' '+ds.overflowY);
 const detail=$('.sub-detail',task());
 need(detail.scrollHeight<=detail.clientHeight+1,'the opened task is cut: '+detail.scrollHeight+' > '+detail.clientHeight);

 // 8. a task that handed in no report body opens its reply by default
 const other=$('.sub-task',card())[0];
 $('.action-row',other).click();await wait(450);
 const otherReply=$('.sa-sec-reply',other);
 need(otherReply&&$('.sa-sec-row',otherReply).getAttribute('aria-expanded')==='true'&&$('.sa-reply li code',otherReply),'the reply of a task without a report body is not open');

 // 9. Chinese: the same parts and wording
 setLang('zh-CN');setView({lang:'zh-CN'});await wait(600);
 const zhTitle=text($('.action-row .action-text',card()));
 need(zhTitle.includes('已委派')&&zhTitle.includes('2 个任务：Agent Core overview · AI Provider overview'),'zh title: '+zhTitle);
 const labels=$$('.sa-sec-label',task()).map(text).join('|');
 need(labels==='任务|过程|报告|子智能体回答','zh labels: '+labels);
 need(text($('.sa-sec-text',proc())).includes('已提交报告'),'zh process line: '+text($('.sa-sec-text',proc())));
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {const p=document.createElement('p');p.id='ready';p.textContent=error.message+' '+error.stack;document.body.append(p);}
`,
			);
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12_000));
				return {};
			});
			server.route("GET", "/api/git/status", () => ({ gitAvailable: false, isRepository: false }));
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Sub-agent detail parts",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90_000,
);
