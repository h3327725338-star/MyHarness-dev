import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// The workflow / ultracode delegation card in the conversation is as light as a tool row: the tool's name is said once,
// the phases are small grey rows with a thin status mark (no filled pill, no bold), a sub-task is one line whose long
// activity or error text is cut with an ellipsis (the whole text is its title), and nothing rules the card at its left.
const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"draws the delegation card light: one tool name, small phase rows, one line per sub-task, no side rule",
	async () => {
		// Absolute: a relative browser profile makes Chrome pop up a "cannot create data directory" box on the desktop.
		const base = resolve(process.env.MYHARNESS_TEMP_DIR || tmpdir());
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "agent-card-light-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><div id="app" style="width:760px"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>',
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
const longError='delegated-write-guard blocked this call: '+'very long raw message '.repeat(14)+'\\nsecond raw line of the error\\nthird raw line of the error';
const running={name:'core-scan',status:'running',model:'claude-sonnet-5-5',activePhase:0,phases:[
 {name:'Investigate',status:'running',completed:1,total:3,results:[
  {description:'scan module A',prompt:'p',status:'running',toolUseCount:2,lastToolInfo:longError,transcript:[]},
  {description:'scan module B',prompt:'p',status:'completed',toolUseCount:5,durationMs:4200,lastToolInfo:'done',transcript:[]},
  {description:'scan module C',prompt:'p',status:'failed',toolUseCount:1,error:longError,lastToolInfo:longError,transcript:[]}]},
 {name:'Verify',status:'pending',completed:0,total:2,results:[]}]};
const finished={name:'quick-check',status:'completed',model:'claude-sonnet-5-5',activePhase:0,phases:[
 {name:'Investigate',status:'completed',completed:1,total:1,results:[{description:'read the config',prompt:'p',status:'completed',toolUseCount:3,durationMs:2100,lastToolInfo:'done',output:'ok',transcript:[]}]}]};
try {
 setView({processDefault:'expanded'});
 const items=[
  {kind:'user',id:'u1',ts:1,text:'first',images:[]},
  {kind:'assistant',id:'a1',ts:2,blocks:[{type:'toolCall',id:'c2',name:'workflow',args:{phases:[{name:'Investigate',tasks:[{description:'read the config',prompt:'p'}]}]}}],stopReason:'toolUse'},
  {kind:'toolResult',ts:3,toolCallId:'c2',toolName:'workflow',text:'workflow finished',details:finished,isError:false},
  {kind:'assistant',id:'a1f',ts:4,blocks:[{type:'text',text:'done'}],stopReason:'stop',final:true},
  {kind:'user',id:'u2',ts:5,text:'second',images:[]},
  {kind:'assistant',id:'a2',ts:6,blocks:[{type:'toolCall',id:'c1',name:'ultracode',args:{name:'core-scan',phases:[{name:'Investigate',tasks:[]},{name:'Verify',tasks:[]}]}}],stopReason:'toolUse'}];
 set({items,snap:{active:true,cwd:'C:/test',flags:{},session:{id:'test'},run:{startedAt:Date.now()}},toolRuns:{c1:{status:'running',partialDetails:running}},runs:{},dialogs:[],userBash:{},userBashOrder:[]});
 render(h(Transcript,{}),app);await wait(500);
 const card=id=>$('.action[data-tool-call="'+id+'"]');
 const live=card('c1'), done=card('c2');
 need(live&&done,'the two delegation rows were not drawn');
 const title=el=>$('.action-row .action-text',el).textContent.replace(/\\s+/g,' ').trim();
 const times=(text,word)=>text.split(word).length-1;

 // 1. the tool's name once, in the title row, with and without a workflow name
 need(times(title(live),'ultracode')===1,'ultracode is not said exactly once: '+title(live));
 need(title(live).includes('core-scan'),'the workflow name is not in the title: '+title(live));
 need(times(title(done),'workflow')===1,'workflow is not said exactly once: '+title(done));
 need(!/ultracode ultracode|workflow workflow/.test(title(live)+' '+title(done)),'tool name repeated');

 // 2. phase rows: a small grey row with a thin mark, no filled pill, no bold
 const sub=$('.sub-agent',live);
 need(sub,'no .sub-agent card under the live row');
 need(!$('.badge',sub),'a filled badge is still in the card');
 need(!$('strong',sub),'a bold name is still in the card');
 const heads=$$('.sub-phase-head',sub);
 need(heads.length===2,'expected 2 phase rows, got '+heads.length);
 const hs=getComputedStyle(heads[0]);
 need(Number(hs.fontWeight)<=400,'phase row is bold: '+hs.fontWeight);
 need(parseFloat(hs.fontSize)<=12,'phase row is larger than the small size: '+hs.fontSize);
 need($('.action-ico',heads[0]).children.length>0,'phase row has no status mark');
 need($('.sub-phase-count',heads[0]).textContent.trim()==='1/3','phase progress lost: '+$('.sub-phase-count',heads[0]).textContent);
 need($('.sub-phase-count',heads[1]).textContent.trim()==='0/2','pending phase progress lost');
 need(!$('.dim .badge',sub)&&getComputedStyle($('.sub-phase-count',heads[0])).backgroundColor==='rgba(0, 0, 0, 0)','the phase count has a fill');

 // 3. one line per sub-task, long text cut with an ellipsis, whole text as its title
 const tasks=$$('.sub-task',sub);
 need(tasks.length===3,'expected 3 sub-tasks, got '+tasks.length);
 need(!$('.sub-last',sub),'the old multi-line activity block is back');
 const mainRow=$('.action-row',live);
 for(const task of tasks){
  const row=$('.action-row',task);
  need(row.getBoundingClientRect().height<=mainRow.getBoundingClientRect().height,'a sub-task row is taller than a tool row: '+row.getBoundingClientRect().height);
 }
 const notes=$$('.sub-note',sub);
 need(notes.length===2,'expected notes for the running and the failed task only, got '+notes.length);
 for(const note of notes){
  const s=getComputedStyle(note);
  need(s.whiteSpace==='nowrap'&&s.textOverflow==='ellipsis'&&s.overflow==='hidden','note is not one ellipsized line');
  need(note.getBoundingClientRect().height<=20,'note is taller than one line: '+note.getBoundingClientRect().height);
  need(!note.textContent.includes('\\n'),'note text holds a line break');
  need(note.scrollWidth>note.clientWidth,'the long note was not cut (test text too short?)');
  need((note.getAttribute('title')||'').includes('third raw line of the error'),'the title does not carry the whole text');
 }
 need(!$('.sub-note',tasks[1]),'a completed task shows a note');
 need(!tasks[2].querySelector('.sub-note.dim')&&tasks[2].querySelector('.sub-note.bad'),'the failed note is not in the danger style');
 const probe=document.createElement('span');probe.style.color='var(--danger)';document.body.append(probe);
 need(getComputedStyle($('.sub-note.bad',tasks[2])).color===getComputedStyle(probe).color,'the error note lost the danger color');
 need(parseFloat(getComputedStyle($('.sub-note.bad',tasks[2])).fontSize)<=11.5,'the error note is large');

 // 4. no side rule, tight spacing
 const ss=getComputedStyle(sub);
 need(ss.borderLeftWidth==='0px'&&ss.paddingLeft==='0px','the card still has a rule or padding at its left: '+ss.borderLeftWidth+' '+ss.paddingLeft);

 // 5. the fold of the call and of a sub-task still opens and closes
 const taskRow=$('.action-row',tasks[0]);
 need(taskRow.getAttribute('aria-expanded')==='false','sub-task starts open');
 taskRow.click();await wait(450);
 need(taskRow.getAttribute('aria-expanded')==='true'&&$('.sub-detail',tasks[0]),'sub-task did not open its detail');
 taskRow.click();await wait(450);
 need(taskRow.getAttribute('aria-expanded')==='false','sub-task did not close');
 mainRow.click();await wait(450);
 need(mainRow.getAttribute('aria-expanded')==='true'&&$('.raw',live),'the call row did not open its raw details');
 need($('.sub-agent',live),'the card went away when the call row opened');
 mainRow.click();await wait(450);

 // 6. a finished card: tool name once, a completed phase mark, no note on a completed task
 const dsub=$('.sub-agent',done);
 need(dsub&&!$('.badge',dsub)&&$$('.sub-note',dsub).length===0,'finished card is not light');

 // 7. Chinese: same structure, the phase row uses the sub-agent list's wording
 setLang('zh-CN');setView({lang:'zh-CN'});await wait(600);
 need(times(title(card('c1')),'ultracode')===1,'zh: ultracode not once: '+title(card('c1')));
 need(title(card('c1')).includes('正在委派'),'zh: verb missing: '+title(card('c1')));
 need($('.sub-phase-head',card('c1')).textContent.includes('阶段 1'),'zh: phase wording missing: '+$('.sub-phase-head',card('c1')).textContent);
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
				label: "Delegation card weight",
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
