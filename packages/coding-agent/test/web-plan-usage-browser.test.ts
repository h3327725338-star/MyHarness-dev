import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

// The plan-limits meter in the composer bar (plan-usage.js, composer.css .plan-meter, panels.css .pu): hidden while there
// are no readings, in front of the context ring, text gone and glyph kept in a narrow bar, colours by what is left, a
// popover with every source, and the refresh requests the page makes (once on mount, once when the popover opens, one
// per press of a source's refresh button).
const planJs = `
import {h,render} from '/vendor/preact.js';
import {Composer} from '/js/composer.js';
import {set,setView} from '/js/store.js';
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const check=(c,m)=>{if(!c) throw Error(m);};
const frame=document.getElementById('frame');
const log=[];
const MIN=60000,HOUR=3600000,DAY=86400000;
const now=Date.now();
const win=(kind,leftPercent,resetsAt)=>({kind,leftPercent,resetsAt});
const claude={id:'claude-code',label:'Claude',observedAt:now-2*MIN,nextRefreshAt:now+3*MIN+30000,groups:[
 {label:'',windows:[win('five_hour',93,now+4*HOUR+40*MIN+30000),win('weekly',74,now+5*DAY+30000)]},
 {label:'Fable',modelIds:['fable'],windows:[win('weekly',79,now+5*DAY+30000)]}]};
const agy={id:'agy',label:'agy',observedAt:now-12*MIN,groups:[
 {label:'Gemini Models',modelIds:['gemini-pro'],windows:[win('five_hour',26,now+2*HOUR+30000),win('weekly',69,now+3*DAY+30000)]},
 {label:'Claude and GPT models',modelIds:['claude-sonnet'],windows:[win('five_hour',100),win('weekly',100)]},
 {label:'Gemini 4 Argon',modelIds:['gemini-4-argon'],windows:[win('weekly',99,now+6*DAY+30000)]}]};
const snapOf=(provider,id,session)=>({cwd:'C:/t',active:false,trust:{trusted:true},flags:{},session:{id:session,file:'C:/fixture/'+session+'.jsonl'},
 model:{id,name:id,provider,input:['text']},
 thinking:{supported:true,level:'medium',levels:['low','medium','high']},
 context:{budget:{activeTokens:120,effectiveWindow:8000,percent:2}},run:{},queue:{},app:{}});
const sizeTo=async(w)=>{frame.style.width=w+'px';frame.dataset.w=w<430?'xs':w<620?'s':'m';await wait(150);};
const meter=()=>document.querySelector('#frame .composer-bar .plan-meter');
const text=()=>meter().querySelector('.plan-text').textContent;
const fills=()=>[...meter().querySelectorAll('.plan-bar > .cu-fill')].map((f)=>f.style.width+'|'+f.className);
try {
 set({items:[],snap:snapOf('claude-code','claude-opus-5-5','plan-a'),
  surface:{widgets:{},statuses:{}},queue:{steering:[],followUp:[]},dialogs:[],resources:{commands:[],tools:[],skills:[],templates:[],extensions:[]}});
 setView({lang:'en'});
 render(h(Composer,{}),frame);
 await wait(300);
 check(!meter(),'the meter shows although there are no readings');
 set({planUsage:{sources:[claude,agy]}});
 await wait(200);
 check(meter(),'the meter is missing with readings');
 const bar=document.querySelector('#frame .composer-bar');
 const anchor=meter().closest('.picker-anchor');
 check(anchor.nextElementSibling&&anchor.nextElementSibling.querySelector('.meter'),'the meter is not right before the context ring');
 check(anchor.previousElementSibling&&anchor.previousElementSibling.querySelector('.chip'),'the meter does not follow the effort picker');
 check(meter().getAttribute('aria-haspopup')==='dialog','aria-haspopup missing');
 // The chat is on the Claude provider: its plan-wide limit, five-hour on top, weekly below.
 await sizeTo(760);
 check(text()==='5h 93% · 7d 74%','wrong text on the wide bar: '+text());
 check(getComputedStyle(meter().querySelector('.plan-text')).display!=='none','the text is hidden on a wide bar');
 const f=fills();
 check(f[0].startsWith('93%')&&f[1].startsWith('74%'),'wrong fills '+f.join(','));
 check(meter().title==='Claude plan left: 5-hour 93%, resets in 4 h 40 min; Weekly 74%, resets in 5 d 0 h','wrong tooltip: '+meter().title);
 check(meter().className.trim()==='plan-meter','a healthy meter carries a level class: '+meter().className);
 // Geometry: two 16x4 bars one above the other, centred in a 28px high button whose centre line is the context ring's.
 const glyph=[...meter().querySelectorAll('.plan-bar')].map((b)=>b.getBoundingClientRect());
 const button=meter().getBoundingClientRect();
 const ring=document.querySelector('#frame .composer-bar .meter').getBoundingClientRect();
 check(glyph.length===2&&Math.round(glyph[0].width)===16&&Math.round(glyph[0].height)===4&&glyph[1].top>=glyph[0].bottom,'wrong glyph geometry '+JSON.stringify(glyph));
 check(Math.round(button.height)===28,'the button is '+button.height+'px high');
 check(Math.abs((glyph[0].top+glyph[1].bottom)/2-(button.top+button.bottom)/2)<=1,'the glyph is not centred in the button');
 check(Math.abs((button.top+button.bottom)/2-(ring.top+ring.bottom)/2)<=1,'the button is off the centre line of the ring');
 // Narrow bars keep only the glyph, still inside the card and still a square button.
 for(const w of [620,520,420,340]){
  await sizeTo(w);
  const width=Math.round(bar.getBoundingClientRect().width);
  const textShown=getComputedStyle(meter().querySelector('.plan-text')).display!=='none';
  log.push(w+':'+width+':'+textShown);
  check(textShown===(width>460),w+'px (bar '+width+'): the text is '+(textShown?'shown':'hidden')+' against the 460px rule');
  const card=bar.closest('.composer').getBoundingClientRect();
  check(bar.querySelector('.send').getBoundingClientRect().right<=card.right+0.5,w+'px: the send button is pushed out of the card');
  check(meter().querySelector('.plan-glyph').getBoundingClientRect().width>0,w+'px: the glyph is gone');
  if(!textShown) check(Math.round(meter().getBoundingClientRect().width)===28,w+'px: the glyph-only button is '+meter().getBoundingClientRect().width+'px wide');
  const chips=[...bar.querySelectorAll('.chip-text')];
  check(chips.every((c)=>c.clientWidth>=48),w+'px: the meter leaves a chip only '+chips.map((c)=>c.clientWidth).join('/')+'px');
 }
 await sizeTo(760);
 // The popover: every source, every group, the reset lines and the refresh buttons.
 meter().click();
 await wait(400);
 const pop=document.querySelector('.popover .pu');
 check(pop,'the popover did not open');
 const sections=[...pop.querySelectorAll('.pu-source')];
 check(sections.length===2,'expected two sources, got '+sections.length);
 const labels=sections.map((s)=>s.querySelector('.pu-head strong').textContent);
 check(labels.join()==='Claude,agy','wrong source order '+labels);
 const captions=(s)=>[...s.querySelectorAll('.pu-caption')].map((c)=>c.textContent).join('|');
 check(captions(sections[0])==='All models|Fable','wrong Claude groups '+captions(sections[0]));
 check(captions(sections[1])==='Gemini Models|Claude and GPT models|Gemini 4 Argon','wrong agy groups '+captions(sections[1]));
 const rows=(s)=>[...s.querySelectorAll('.pu-row')].map((r)=>r.querySelector('.pu-name').textContent+' '+r.querySelector('.pu-pct').textContent);
 check(rows(sections[0]).join()==='5-hour 93%,Weekly 74%,Weekly 79%','wrong Claude rows '+rows(sections[0]));
 check(rows(sections[1]).join()==='5-hour 26%,Weekly 69%,5-hour 100%,Weekly 100%,Weekly 99%','wrong agy rows '+rows(sections[1]));
 const reset=(s)=>[...s.querySelectorAll('.pu-reset')].map((r)=>r.textContent);
 // After about 19:20 the reset falls on the next day, which the clock then names.
 check(/^Resets in 4 h 40 min \\((\\w{3} )?\\d\\d:\\d\\d\\)$/.test(reset(sections[0])[0]),'wrong reset line '+reset(sections[0])[0]);
 check(/^Resets in 5 d 0 h \\((\\w{3} )?\\d\\d:\\d\\d\\)$/.test(reset(sections[0])[1]),'wrong weekly reset line '+reset(sections[0])[1]);
 check(reset(sections[1])[2]==='Not started yet: the window starts with the next request','wrong idle line '+reset(sections[1])[2]);
 check(sections[0].querySelector('.pu-age').textContent==='Updated 2 min ago','wrong age '+sections[0].querySelector('.pu-age').textContent);
 check(sections[1].querySelector('.pu-age').textContent==='Updated 12 min ago','wrong age '+sections[1].querySelector('.pu-age').textContent);
 const buttons=sections.map((s)=>s.querySelector('.pu-head .icon-btn'));
 check(buttons[0].disabled&&buttons[0].title==='Can refresh again in 3 min','Claude refresh should wait: '+buttons[0].disabled+' '+buttons[0].title);
 check(!buttons[1].disabled,'the agy refresh button is disabled');
 check(pop.querySelector('.pu-foot').textContent.startsWith('Percent left of each limit.'),'the footer is missing');
 const popBox=pop.parentElement.getBoundingClientRect();
 check(pop.parentElement.scrollWidth<=pop.parentElement.clientWidth,'the popover scrolls sideways');
 const barWidths=[...pop.querySelectorAll('.pu-row .cu-bar')].map((b)=>Math.round(b.getBoundingClientRect().width));
 check(barWidths.length===8&&barWidths.every((w)=>w>=120),'the popover bars are too narrow: '+barWidths.join());
 check(Math.round(popBox.width)===340&&popBox.bottom<=meter().getBoundingClientRect().top,'the popover is not 340px wide above the button: '+popBox.width);
 buttons[1].click();
 await wait(300);
 // A source being read shows a spinner and cannot be asked again.
 set({planUsage:{sources:[claude,{...agy,refreshing:true}]}});
 await wait(150);
 const busy=document.querySelectorAll('.pu-source')[1].querySelector('.pu-head .icon-btn');
 check(busy.disabled&&busy.querySelector('.spinner'),'a source being read is not marked');
 // Unavailable and error text.
 set({planUsage:{sources:[{id:'agy',label:'agy',groups:[],unavailable:'agy is not signed in'},{...claude,error:'timed out'}]}});
 await wait(150);
 const notes=[...document.querySelectorAll('.pu-note')].map((n)=>n.textContent);
 // The chat is on Claude: its plan stands first, whatever order the sources came in.
 check(notes.join('|')==='Could not read the plan limits: timed out|agy is not signed in','wrong notes '+notes.join('|'));
 check(document.querySelectorAll('.pu-source')[0].querySelectorAll('.pu-group').length===2,'the last known groups are gone after an error');
 check(document.querySelectorAll('.pu-source')[1].querySelectorAll('.pu-group').length===0,'an unavailable source still lists groups');
 // A new chat closes the popover.
 set({snap:snapOf('claude-code','claude-opus-5-5','plan-b')});
 await wait(400);
 check(!document.querySelector('.popover .pu'),'the popover stays open in another chat');
 // Colours: the worse of the two windows colours the button, each bar its own.
 const lowFive={id:'claude-code',label:'Claude',observedAt:now,groups:[{label:'',windows:[win('five_hour',8,now+HOUR),win('weekly',60,now+DAY)]}]};
 set({planUsage:{sources:[lowFive]}});
 await wait(150);
 check(meter().classList.contains('danger'),'8% left is not danger: '+meter().className);
 check(fills()[0].includes('danger')&&!fills()[1].includes('danger')&&!fills()[1].includes('warn'),'wrong bar colours '+fills().join());
 const warnWeek={...lowFive,groups:[{label:'',windows:[win('five_hour',80,now+HOUR),win('weekly',20,now+DAY)]}]};
 set({planUsage:{sources:[warnWeek]}});
 await wait(150);
 check(meter().classList.contains('warn')&&fills()[1].includes('warn'),'20% left is not warn: '+meter().className+' '+fills().join());
 // A window past its reset time shows a dash, not its old number.
 const past={...lowFive,groups:[{label:'',windows:[win('five_hour',8,now-MIN),win('weekly',60,now+DAY)]}]};
 set({planUsage:{sources:[past]}});
 await wait(150);
 check(text()==='5h – · 7d 60%','an expired window is not a dash: '+text());
 check(!meter().classList.contains('danger'),'an expired window still colours the button');
 // A chat on another provider shows the plan that is closest to running out, over its plan-wide numbers.
 set({snap:snapOf('openai','gpt-x','plan-c'),planUsage:{sources:[claude,agy]}});
 await wait(150);
 check(text()==='agy 5h 26% · 7d 69%','wrong text for a chat on another provider: '+text());
 check(meter().title.startsWith('agy plan left: '),'wrong source for a chat on another provider: '+meter().title);
 // A chat on the agy provider sees the pool of its own model.
 set({snap:snapOf('agy','claude-sonnet','plan-d')});
 await wait(150);
 check(text()==='5h 100% · 7d 100%','wrong pool for an agy model: '+text());
 check(meter().title.includes('5-hour 100%, not started yet'),'wrong tooltip for a window that has not started: '+meter().title);
 // Without any source the meter is gone again.
 set({planUsage:{sources:[]}});
 await wait(150);
 check(!meter(),'the meter stays with no sources');
 const calls=await (await fetch('/api/plan-usage-log')).json();
 const shape=calls.map((c)=>JSON.stringify(c));
 check(shape[0]==='{"maxAgeMs":300000}','the mount did not ask with a 5 minute age: '+shape.join(' '));
 check(shape.includes('{"maxAgeMs":60000}'),'opening the popover did not ask with a 1 minute age: '+shape.join(' '));
 check(shape.includes('{"id":"agy","maxAgeMs":0}'),'the refresh button did not ask for its source: '+shape.join(' '));
 check(shape.length===3,'unexpected requests '+shape.join(' '));
 const done=document.createElement('p');done.id='ready';done.textContent='passed';
 document.body.append(done);
} catch(error) { const fail=document.createElement('p');fail.id='ready';fail.textContent='FAILED '+error.message+' '+JSON.stringify(log);document.body.append(fail); }
`;

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"plan limits meter: glyph, narrow bar, popover, colours and refresh requests",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-plan-usage-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		const asked: unknown[] = [];
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/git/status", () => ({ gitAvailable: false, isRepository: false }));
			server.route("GET", "/api/resources", () => ({
				commands: [],
				contextFiles: [],
				tools: [],
				skills: [],
				templates: [],
				extensions: [],
			}));
			server.route("GET", "/api/models", () => ({ providers: [] }));
			server.route("POST", "/api/modes/state", () => ({
				state: { lastSessionFile: null, model: null, drafts: {} },
			}));
			// The refresh answers with no source list: the page keeps the numbers the test sets, and the body is recorded.
			server.route("POST", "/api/plan-usage/refresh", ({ body }) => {
				asked.push(body);
				return {};
			});
			server.route("GET", "/api/plan-usage-log", () => asked);
			writeFileSync(join(root, "test.js"), planJs);
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/composer.css"><div style="height:420px"></div><div id="frame" class="main" style="height:420px;justify-content:flex-end"></div><script type="module" src="/test/test.js"></script>',
			);
			server.mount({ prefix: "/test/", directory: root });
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Plan usage meter test",
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
