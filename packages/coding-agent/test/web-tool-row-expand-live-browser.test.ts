// Browser lock for a tool row the user expanded while the agent is still working: more tool calls, tool results, text,
// a transcript read and the end of the turn arrive, and the row must stay expanded. On a real page (the way
// web-tool-card-compact-browser does it) each scenario expands a row, pushes the next events through the store and
// samples the row on every DOM mutation, so a frame in which the row was folded or gone is caught, not only the end state.
//   S1 a second call of the same kind joins the first one (a lone row becomes a "Read 2 files" group)
//   S2 the model writes text between two calls (the step block used to fold itself under the open row)
//   S3 events that must not touch the row: another kind of call, tool output, a result, a text delta (same DOM node)
//   S4 the turn ends (its steps fold into one block)
//   S5 the transcript is read again while the row is open (the same calls come back without their live ids)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// The page script must not contain backticks or ${ ... } sequences, and it leaves its evidence in the DOM.
const BROWSER_JS = `
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {set,setView,state} from '/js/store.js';
const wait=(ms)=>new Promise((r)=>setTimeout(r,ms));
const app=document.getElementById('app');
const out={};
const user={kind:'user',id:'u1',ts:1,text:'go',images:[]};
let serial=0;
function call(id,name,args){return {type:'toolCall',id:id,name:name,args:args};}
function reply(id,blocks,opts){
  const o=opts||{};
  return {kind:'assistant',id:o.noLive?id:undefined,liveId:o.noLive?undefined:'L-'+id,ts:2+(serial++),model:'m',blocks:blocks,stopReason:'toolUse',final:o.final!==false};
}
function result(id,text){return {kind:'toolResult',id:'r-'+id,toolCallId:id,toolName:'x',text:text,isError:false,ts:3+(serial++),details:{}};}
function runsFor(ids,status){const m={};for(const id of ids)m[id]={status:status||'done',startedAt:2,endedAt:3};return m;}
function snapOf(name,active){return {active:active,cwd:'C:/t',flags:{},session:{id:name},thinking:{supported:true},run:{startedAt:Date.now()}};}
function row(id){return document.querySelector('[data-tool-call="'+id+'"] > .action-row');}
// What the user sees of the row: it says expanded, and its details and every fold around them are open and have a size.
function shown(id){
  const r=row(id);
  if(!r||r.getAttribute('aria-expanded')!=='true')return false;
  const raw=r.parentElement.querySelector(':scope > .collapse > .collapse-inner > .raw');
  if(!raw)return false;
  for(let el=raw;el&&el!==app;el=el.parentElement){if(el.classList.contains('collapse')&&!el.classList.contains('open'))return false;}
  return raw.getBoundingClientRect().height>0;
}
async function until(test,ms){let w=0;while(!test()&&w<(ms||6000)){await wait(40);w+=40;}return test();}
function start(name,items,toolRuns){
  render(null,app);
  set({items:items,snap:snapOf(name,true),dialogs:[],runs:{},toolRuns:toolRuns||{},userBash:{},userBashOrder:[],models:[]});
  render(h(Transcript,{}),app);
}
// Watch c1 on every mutation until stop(): how many mutations saw it folded or gone, and whether its node was replaced.
function watch(id,first){
  const w={lost:0,replaced:false,first:first,stop:null};
  const check=()=>{if(!shown(id))w.lost++;const r=row(id);if(r&&w.first&&r!==w.first)w.replaced=true;};
  const obs=new MutationObserver(check);
  obs.observe(app,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-expanded','class']});
  w.stop=()=>{obs.disconnect();return {lost:w.lost,replaced:w.replaced};};
  return w;
}
async function expandFirst(name,items,toolRuns){
  start(name,items,toolRuns);
  if(!(await until(()=>row('c1'))))throw Error(name+': c1 row never rendered');
  row('c1').click();
  if(!(await until(()=>shown('c1'))))throw Error(name+': c1 never showed its details');
  return row('c1');
}
async function push(items,toolRuns,snap){
  set({items:items,toolRuns:toolRuns||state.toolRuns,...(snap?{snap:snap}:{})});
  await wait(450);
}
try{
  setView({lang:'en',motion:'off',processDefault:'collapsed'});
  const readA=call('c1','read',{path:'src/a.ts'});
  const readB=call('c2','read',{path:'src/b.ts'});

  // S1: a second read joins the first read.
  {
    const items=[user,reply('a1',[readA]),result('c1','alpha')];
    const el=await expandFirst('s1',items,runsFor(['c1']));
    const w=watch('c1',el);
    await push([...items,reply('a2',[readB]),result('c2','beta')],runsFor(['c1','c2']));
    const seen=w.stop();
    out.s1={shown:shown('c1'),lost:seen.lost,replaced:seen.replaced,groups:document.querySelectorAll('.group').length,rowCount:document.querySelectorAll('.action').length};
  }

  // S2: the model writes text, then calls another tool; the open row stays open the whole time.
  {
    const items=[user,reply('a1',[readA]),result('c1','alpha')];
    const el=await expandFirst('s2',items,runsFor(['c1']));
    const w=watch('c1',el);
    const base=[...items];
    await push([...base,reply('a2',[{type:'text',text:'Now I will look at the next file.'}],{final:false})],runsFor(['c1']));
    out.s2a={shown:shown('c1'),summaryOpen:document.querySelector('.summary-head')?.getAttribute('aria-expanded')};
    await push([...base,reply('a2',[{type:'text',text:'Now I will look at the next file.'},call('c2','bash',{command:'ls'})],{final:false})],runsFor(['c1']));
    out.s2b={shown:shown('c1'),summaryOpen:document.querySelector('.summary-head')?.getAttribute('aria-expanded')};
    await push([...base,reply('a2',[{type:'text',text:'Now I will look at the next file.'},call('c2','bash',{command:'ls'})]),result('c2','listing')],runsFor(['c1','c2']));
    const seen=w.stop();
    out.s2={shown:shown('c1'),lost:seen.lost,replaced:seen.replaced,summaryOpen:document.querySelector('.summary-head')?.getAttribute('aria-expanded')};
  }

  // S3: a call of another kind, tool output, its result and a text delta change nothing about the open row.
  {
    const items=[user,reply('a1',[readA]),result('c1','alpha')];
    const el=await expandFirst('s3',items,runsFor(['c1']));
    const w=watch('c1',el);
    const second=call('c2','bash',{command:'ls'});
    const steps=[];
    await push([...items,reply('a2',[second],{final:false})],{...runsFor(['c1']),c2:{status:'running',startedAt:5,partial:'a'}});
    steps.push(shown('c1'));
    await push([...items,reply('a2',[second],{final:false})],{...runsFor(['c1']),c2:{status:'running',startedAt:5,partial:'ab'}});
    steps.push(shown('c1'));
    await push([...items,reply('a2',[second]),result('c2','done')],runsFor(['c1','c2']));
    steps.push(shown('c1'));
    const quiet=w.stop();
    const w2=watch('c1',el);
    await push([...items,reply('a2',[second]),result('c2','done'),reply('a3',[{type:'text',text:'All'}],{final:false})]);
    steps.push(shown('c1'));
    await push([...items,reply('a2',[second]),result('c2','done'),reply('a3',[{type:'text',text:'All done, here is the answer.'}],{final:false})]);
    steps.push(shown('c1'));
    const seen=w2.stop();
    out.s3={steps:steps,quietLost:quiet.lost,quietReplaced:quiet.replaced,sameNode:row('c1')===el,textLost:seen.lost};
  }

  // S4: the turn ends.
  {
    const items=[user,reply('a1',[readA]),result('c1','alpha'),reply('a2',[{type:'text',text:'Done.'}])];
    const el=await expandFirst('s4',[user,reply('a1',[readA]),result('c1','alpha')],runsFor(['c1']));
    const w=watch('c1',el);
    await push(items,runsFor(['c1']),snapOf('s4',false));
    const seen=w.stop();
    out.s4={shown:shown('c1'),lost:seen.lost,replaced:seen.replaced,summaryOpen:document.querySelector('.summary-head')?.getAttribute('aria-expanded')};
  }

  // S5: the transcript is read again: the same calls come back saved, without their live ids. The step list starts with
  // reasoning, whose key follows the message id, so every block of the turn is built again.
  {
    const think={type:'thinking',text:'Let me read the file first.'};
    const items=[user,reply('a1',[think,readA]),result('c1','alpha')];
    await expandFirst('s5',items,runsFor(['c1']));
    const w=watch('c1',null);
    await push([user,reply('a1',[think,readA],{noLive:true}),result('c1','alpha')],runsFor(['c1']));
    const seen=w.stop();
    out.s5={shown:shown('c1'),lost:seen.lost};
  }
  // Current choices, rather than a history of clicks, decide whether completion may fold the chain.
  out.autoFold=[];
  for(const kind of ['tool','thinking']){
    for(const keepOpen of [false,true]){
      const name='fold-'+kind+'-'+keepOpen;
      const block=kind==='tool'?readA:{type:'thinking',text:'Reasoning body to inspect.'};
      const items=[user,reply('a1',[block]),...(kind==='tool'?[result('c1','alpha')]:[])];
      start(name,items,runsFor(['c1']));
      const target=()=>kind==='tool'?row('c1'):document.querySelector('.thinking .group-head');
      if(!(await until(()=>target())))throw Error(name+': missing fold');
      target().click();
      if(!(await until(()=>target().getAttribute('aria-expanded')==='true')))throw Error(name+': did not open');
      if(!keepOpen){
        target().click();
        if(!(await until(()=>target().getAttribute('aria-expanded')==='false')))throw Error(name+': did not close');
      }
      await push([...items,reply('end',[{type:'text',text:'Done.'}])],runsFor(['c1']),snapOf(name,false));
      out.autoFold.push({kind:kind,keepOpen:keepOpen,summary:document.querySelector('.summary-head').getAttribute('aria-expanded'),child:target()?.getAttribute('aria-expanded')});
    }
  }

  // Two expanded calls: closing only one must not hide the other at completion.
  {
    const name='two-open';
    const items=[user,reply('a1',[readA,call('c2','bash',{command:'ls'})]),result('c1','alpha'),result('c2','listing')];
    start(name,items,runsFor(['c1','c2']));
    await until(()=>row('c2'));
    row('c1').click();row('c2').click();
    await until(()=>shown('c1')&&shown('c2'));
    row('c1').click();
    await until(()=>row('c1').getAttribute('aria-expanded')==='false');
    await push([...items,reply('end',[{type:'text',text:'Done.'}])],runsFor(['c1','c2']),snapOf(name,false));
    out.twoOpen={summary:document.querySelector('.summary-head').getAttribute('aria-expanded'),remaining:shown('c2')};
  }

  // A second block is merged into the first at completion, including its manually opened reasoning or tool row.
  out.merged=[];
  for(const kind of ['tool','thinking']){
    const name='merge-'+kind;
    const block=kind==='tool'?call('c2','bash',{command:'ls'}):{type:'thinking',text:'Later reasoning body.'};
    const items=[user,reply('a1',[readA]),result('c1','alpha'),reply('note',[{type:'text',text:'Next step.'}],{final:false}),reply('a2',[block]),...(kind==='tool'?[result('c2','listing')]:[])];
    start(name,items,runsFor(['c1','c2']));
    const target=()=>kind==='tool'?row('c2'):document.querySelector('.thinking .group-head');
    if(!(await until(()=>target())))throw Error(name+': missing second block');
    target().click();
    await until(()=>target().getAttribute('aria-expanded')==='true');
    await push([...items,reply('end',[{type:'text',text:'Done.'}])],runsFor(['c1','c2']),snapOf(name,false));
    out.merged.push({kind:kind,count:document.querySelectorAll('.summary').length,summary:document.querySelector('.summary-head').getAttribute('aria-expanded'),child:target()?.getAttribute('aria-expanded')});
  }

  // A group automatically formed around an open lone row is not an extra manual expansion.
  for(const closeGroup of [false,true]){
    const name='joined-close-'+closeGroup;
    const first=[user,reply('a1',[readA]),result('c1','alpha')];
    await expandFirst(name,first,runsFor(['c1']));
    const items=[...first,reply('a2',[readB]),result('c2','beta')];
    await push(items,runsFor(['c1','c2']));
    if(closeGroup)document.querySelector('.group > .group-head').click();
    else row('c1').click();
    await until(()=>closeGroup?document.querySelector('.group > .group-head').getAttribute('aria-expanded')==='false':row('c1').getAttribute('aria-expanded')==='false');
    await push([...items,reply('end',[{type:'text',text:'Done.'}])],runsFor(['c1','c2']),snapOf(name,false));
    out[name]=document.querySelector('.summary-head').getAttribute('aria-expanded');
  }
  // Explicit chain-header choices still win, and the expanded default must remain expanded.
  out.defaults=[];
  for(const closeHeader of [false,true]){
    const name='defaults-'+closeHeader;
    setView({processDefault:'expanded'});
    const items=[user,reply('a1',[readA]),result('c1','alpha')];
    await expandFirst(name,items,runsFor(['c1']));
    row('c1').click();
    await until(()=>row('c1').getAttribute('aria-expanded')==='false');
    if(closeHeader){
      document.querySelector('.summary-head').click();
      await until(()=>document.querySelector('.summary-head').getAttribute('aria-expanded')==='false');
    }
    await push([...items,reply('end',[{type:'text',text:'Done.'}])],runsFor(['c1']),snapOf(name,false));
    out.defaults.push(document.querySelector('.summary-head').getAttribute('aria-expanded'));
  }
  document.getElementById('boot').textContent='done '+JSON.stringify(out);
}catch(error){
  document.getElementById('boot').textContent='done '+JSON.stringify({error:String((error&&error.message)||error),partial:out});
}
`;

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"a tool row the user expanded while the agent works stays expanded through the events that follow",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-tool-row-live-browser-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			server.route("GET", "/api/settings", () => ({ items: [] }));
			server.route("GET", "/api/trust", () => ({ requiresTrust: false }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				[
					"<!doctype html>",
					'<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css">',
					'<link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/overlays.css">',
					'<div id="app"></div><div id="boot">boot</div>',
					"<script>",
					"window.addEventListener('error',function(e){document.getElementById('boot').textContent='done '+JSON.stringify({error:'PAGE-ERROR '+(e.message||'')+' @ '+(e.filename||'')+':'+(e.lineno||'')});});",
					"</script>",
					'<script src="/markdown/marked.min.js"></script>',
					'<script type="module" src="/test/test.js"></script>',
				].join(""),
			);
			writeFileSync(join(root, "test.js"), BROWSER_JS);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#boot",
				label: "Tool row expanded while live",
				isSolved: (candidate) => candidate.text.includes('id="boot">done'),
			});
			const match = page.text.match(/id="boot">done ([^<]*)<\/div>/);
			expect(match, "browser stats missing").toBeTruthy();
			const stats = JSON.parse(match![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as Record<string, any>;
			// eslint-disable-next-line no-console
			console.log(`[tool-row-expand-live] ${JSON.stringify(stats)}`);
			expect(stats.error, "page error").toBeUndefined();
			// S1: the first read is still open (inside the group the two reads now make), and was never seen folded.
			expect(stats.s1.shown, "S1: row still expanded").toBe(true);
			expect(stats.s1.lost, "S1: mutations that saw the row folded or gone").toBe(0);
			expect(stats.s1.rowCount, "S1: both reads are rows").toBe(2);
			// S2: text and a following call do not fold the block (or the row) under the user.
			expect(stats.s2a.shown, "S2: row open while the model writes text").toBe(true);
			expect(stats.s2b.shown, "S2: row open once the next call starts").toBe(true);
			expect(stats.s2.shown, "S2: row open after the next result").toBe(true);
			expect(stats.s2.lost, "S2: mutations that saw the row folded or gone").toBe(0);
			expect(stats.s2.summaryOpen, "S2: block still open").toBe("true");
			// S3: updates that have nothing to do with the row do not even replace its DOM node.
			expect(
				stats.s3.steps,
				"S3: row expanded after the other call, its output, its result, text, more text",
			).toEqual([true, true, true, true, true]);
			expect(stats.s3.quietLost, "S3: mutations that saw the row folded or gone (call, output, result)").toBe(0);
			expect(stats.s3.quietReplaced, "S3: node replaced (call, output, result)").toBe(false);
			expect(stats.s3.textLost, "S3: mutations that saw the row folded or gone (text)").toBe(0);
			expect(stats.s3.sameNode, "S3: same DOM node at the end").toBe(true);
			// S4: the turn ends.
			expect(stats.s4.shown, "S4: row still expanded after the turn ended").toBe(true);
			expect(stats.s4.lost, "S4: mutations that saw the row folded or gone").toBe(0);
			// S5: the transcript read again.
			expect(stats.s5.shown, "S5: row still expanded after the transcript was read again").toBe(true);
			expect(stats.s5.lost, "S5: mutations that saw the row folded or gone").toBe(0);
			for (const item of stats.autoFold) {
				expect(item.summary, `${item.kind}: completion respects current expansion`).toBe(String(item.keepOpen));
				if (item.keepOpen) expect(item.child, `${item.kind}: opened child stays expanded`).toBe("true");
			}
			expect(stats.twoOpen).toEqual({ summary: "true", remaining: true });
			expect(stats.defaults, "expanded default and explicit chain-header fold remain respected").toEqual([
				"true",
				"false",
			]);
			for (const item of stats.merged) {
				expect(item.count, `${item.kind}: completed blocks merged`).toBe(1);
				expect(item.summary, `${item.kind}: merged chain stays expanded`).toBe("true");
				expect(item.child, `${item.kind}: later expanded child survives merge`).toBe("true");
			}
			expect(stats["joined-close-false"], "closing the row releases its automatically opened group").toBe("false");
			expect(stats["joined-close-true"], "a closed group masks its expanded children").toBe("false");
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	180_000,
);
