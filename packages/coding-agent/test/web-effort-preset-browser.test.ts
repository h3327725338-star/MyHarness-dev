import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { resolveEffortConfiguration } from "../src/providers/models/effort-catalog.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"recognizes the saved DeepSeek version, shows only actual preset levels, preserves manual overrides after saving, and saves the provider's reasoning-level switch",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-effort-preset-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((candidate) => candidate.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		let saved: any;
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("POST", "/api/providers/custom/effort-preset", ({ body }) => {
				const payload = body as { modelId: string; model?: any };
				const result = resolveEffortConfiguration({ ...payload.model, id: payload.modelId });
				return { mode: result.mode, preset: result.preset ?? null };
			});
			server.route("POST", "/api/providers/custom/save", ({ body }) => {
				saved = (body as { config: unknown }).config;
				return { ok: true };
			});
			server.route("GET", "/api/test/saved", () => saved);
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app" style="max-width:700px;margin:30px auto"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {ProviderForm} from '/js/provider-form.js';
import {setLang} from '/js/lang.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw Error(msg)};
const until=async(fn)=>{for(let i=0;i<150;i++){if(fn())return;await wait(40)}throw Error('timed out waiting for the UI')};
let dirty=false;
const card=()=>document.querySelector('.pf-model');
const chips=()=>[...card().querySelectorAll('.pf-levels .chip-toggle')];
const labels=()=>chips().map(el=>el.textContent.trim());
const field=(label)=>[...card().querySelectorAll('label.field-label')].find(el=>el.querySelector('.field-name')?.textContent===label);
const mode=()=>field('推理档位配置').querySelector('[role=combobox]');
async function choose(label,option){
 field(label).querySelector('[role=combobox]').click();
 await until(()=>[...document.querySelectorAll('[role=option]')].some(el=>el.textContent.trim()===option));
 [...document.querySelectorAll('[role=option]')].find(el=>el.textContent.trim()===option).click();
 await wait(80);
}
async function mount(config){
 render(null,document.getElementById('app'));dirty=false;
 render(h(ProviderForm,{initial:{id:'test',config},hasStoredKey:true,onSaved:()=>{},onDirty:value=>{dirty=value}}),document.getElementById('app'));
 await until(()=>card());card().querySelector('.pf-model-toggle').click();await wait(100);
}
async function save(){
 const button=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='保存');
 check(button&&!button.disabled,'save button unavailable');button.click();await until(()=>!dirty);
 return fetch('/api/test/saved').then(response=>response.json());
}
try {
 setLang('zh-CN');
 const original={api:'openai-completions',baseUrl:'https://example.invalid/v1',models:[{id:'deepseek-v4.1-flash-1017',reasoning:true,thinkingLevelMap:{minimal:null,medium:null,max:'max'},contextWindow:350000,maxTokens:128000,input:['text','image']}]};
 await mount(original);
 await until(()=>mode()?.textContent.includes('内置预设')&&labels().join(',')==='off,low,high,max');
 check(chips().every(el=>el.tagName==='SPAN'),'preset levels are editable or include unsupported choices');
 check(card().textContent.includes('官方资料确认的实际档位'),'official source explanation missing');
 check(!card().textContent.includes('没有任何来源'),'misleading unknown-source text remains');
 check(!dirty,'automatic preset lookup dirtied the form');
 await choose('默认推理档位','low');
 const catalog=await save();
 check(catalog.models[0].thinkingLevelMode==='catalog','preset mode not saved');
 check(catalog.models[0].defaultThinkingLevel==='low','model default lost');
 check(catalog.models[0].reasoning===true&&JSON.stringify(catalog.models[0].thinkingLevelMap)===JSON.stringify({off:'none',minimal:null,low:'low',medium:null,high:'high',xhigh:null,max:'max'}),'legacy reasoning fields were not kept next to the preset: '+JSON.stringify(catalog.models[0]));
 await mount(catalog);
 await until(()=>labels().join(',')==='off,low,high,max');
 check(field('默认推理档位').querySelector('[role=combobox]').textContent.includes('low'),'default not restored');
 await choose('推理档位配置','手动覆盖');
 check(chips().length===7&&chips().every(el=>el.tagName==='BUTTON'),'manual override cannot edit all candidates');
 const low=chips().find(el=>el.textContent.trim()==='low');low.click();await wait(80);
 check(low.getAttribute('aria-pressed')==='false','manual edit was not applied');
 check(card().textContent.includes('未选中的档位没有启用'),'manual candidate explanation missing');
 const manual=await save();
 check(manual.models[0].thinkingLevelMode==='manual'&&manual.models[0].thinkingLevelMap.low===null,'manual override lost on save');
 await mount(manual);await wait(500);
 check(mode().textContent.includes('手动覆盖'),'explicit manual mode was replaced automatically');
 check(chips().find(el=>el.textContent.trim()==='low').getAttribute('aria-pressed')==='false','manual level not restored');
 await choose('推理档位配置','内置预设');
 await until(()=>labels().join(',')==='off,low,high,max');
 await choose('推理档位配置','手动覆盖');
 check(chips().find(el=>el.textContent.trim()==='low').getAttribute('aria-pressed')==='false','switching back lost manual backup');
 await choose('推理档位配置','内置预设');
 await until(()=>labels().join(',')==='off,low,high,max');
 const sw=()=>document.querySelector('[role=switch][aria-label="向这个服务发送推理档位"]');
 await mount(original);
 await until(()=>labels().join(',')==='off,low,high,max');
 check(sw()&&sw().getAttribute('aria-checked')==='false','provider switch is missing or on by default');
 check(card().textContent.includes('档位不会随请求发出'),'the model does not say its level is not sent');
 sw().click();await wait(80);
 check(!card().textContent.includes('档位不会随请求发出'),'the not-sent notice stays after the switch is on');
 const sent=await save();
 check(sent.compat&&sent.compat.supportsReasoningEffort===true,'the provider switch was not saved');
 await mount(sent);
 await until(()=>labels().join(',')==='off,low,high,max');
 check(sw().getAttribute('aria-checked')==='true','the provider switch was not restored');
 sw().click();await wait(80);
 const unsent=await save();
 check(unsent.compat&&unsent.compat.supportsReasoningEffort===false,'switching off did not write an explicit false');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "DeepSeek effort preset regression test",
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
