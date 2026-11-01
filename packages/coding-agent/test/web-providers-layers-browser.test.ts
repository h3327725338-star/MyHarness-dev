import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const noCredentials = { active: null, apiKeys: [], hasOAuth: false, runtimeOverride: false };
const saved = (suffix: string) => ({
	active: { type: "api_key", keyId: "k" },
	apiKeys: [{ id: "k", label: "Default key", suffix, active: true }],
	hasOAuth: false,
	runtimeOverride: false,
});
const providerOf = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	name: id,
	enabled: true,
	missingBaseUrl: false,
	configured: true,
	authSource: "stored",
	baseUrl: null,
	modelCount: 1,
	supportsApiKeyLogin: true,
	supportsOAuth: false,
	custom: true,
	credentials: noCredentials,
	...over,
});

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"shows what covers what, marks what no layer sets, and sends exactly what the user changed",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-provider-layers-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((candidate) => candidate.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		const sent: { url: string; body: any }[] = [];
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/providers", () => ({
				providers: [
					providerOf("relay-cheap", { credentials: saved("aaaa") }),
					providerOf("relay-fast"),
					providerOf("solo", { credentials: saved("ssss") }),
					providerOf("model-only"),
					providerOf("overlay", { credentials: saved("oooo") }),
				],
				modelsPath: "C:/somewhere/models.json",
				error: null,
			}));
			server.route("GET", "/api/providers/custom", () => ({
				path: null,
				apiTypes: ["openai-completions", "anthropic-messages"],
				connectionDefaults: {},
				hiddenPlaceholder: "••••••",
				groups: [
					{ id: "relay", config: { name: "Relay", baseUrl: "https://top.example/v1" }, key: { suffix: "gggg" } },
				],
				mergeSuggestions: [
					{
						key: "solo|model-only|third",
						name: "relay.example",
						members: [
							{ id: "solo", name: "solo", host: "relay.example", sure: true },
							{ id: "model-only", name: "model-only", host: "relay.example", sure: true },
							{ id: "third", name: "third", host: "api.example", sure: false },
						],
					},
				],
				providers: [
					{
						id: "relay-cheap",
						config: {
							layered: true,
							group: "relay",
							name: "Cheap group",
							api: "openai-completions",
							baseUrl: "https://own.example/v1",
							authMode: "apiKey",
							models: [{ id: "cheap-model", baseUrl: "https://model.example" }],
						},
						modelKeys: { "cheap-model": { suffix: "mmmm" } },
					},
					{
						id: "relay-fast",
						config: {
							layered: true,
							group: "relay",
							name: "Fast group",
							baseUrl: "https://fast.example/v1",
							authMode: "apiKey",
							models: [{ id: "needs-format" }],
						},
						modelKeys: {},
					},
					{
						id: "solo",
						config: {
							layered: true,
							api: "openai-completions",
							baseUrl: "https://solo.example/v1",
							authMode: "apiKey",
							models: [{ id: "one" }, { id: "two" }],
						},
						modelKeys: {},
					},
					{
						id: "model-only",
						config: {
							layered: true,
							api: "openai-completions",
							baseUrl: "https://only.example/v1",
							authMode: "apiKey",
							models: [{ id: "with-key" }, { id: "without-key" }],
						},
						modelKeys: { "with-key": { suffix: "wwww" } },
					},
					{
						id: "overlay",
						config: {
							name: "overlay",
							baseUrl: "https://overlay.example/v1",
							models: [{ id: "x" }, { id: "y" }],
						},
						modelKeys: {},
					},
				],
			}));
			server.route("GET", "/api/models", () => ({ providers: [] }));
			server.route("GET", "/api/test/sent", () => ({ sent }));
			for (const url of [
				"/api/providers/custom/save",
				"/api/providers/group/save",
				"/api/providers/group/merge",
				"/api/providers/group/leave",
			]) {
				server.route("POST", url, ({ body }) => {
					sent.push({ url, body });
					return { ok: true, id: "solo", missingBaseUrl: false };
				});
			}
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {ProvidersPage} from '/js/providers-page.js';
import {setLang} from '/js/lang.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw Error(msg)};
const until=async(fn,what='the UI')=>{for(let i=0;i<150;i++){const value=await fn();if(value)return value;await wait(40)}throw Error('timed out waiting for '+what)};
const item=(text)=>[...document.querySelectorAll('.prov-item')].find(el=>el.textContent.includes(text));
const card=(id)=>document.querySelector('.prov-key[data-key="'+id+'"]');
const fieldOf=(scope,label)=>[...scope.querySelectorAll('.field-label')].find(el=>el.querySelector('.field-name')?.textContent.trim()===label);
const type=(input,value)=>{input.value=value;input.dispatchEvent(new InputEvent('input',{bubbles:true}))};
const lastSent=async(url,count)=>until(async()=>{const list=(await (await fetch('/api/test/sent')).json()).sent.filter(entry=>entry.url===url);return list.length>=count?list[count-1].body:null},url);
const choose=async(trigger,label)=>{trigger.click();await until(()=>document.querySelector('.select-options'),'the option list');[...document.querySelectorAll('.select-options [role=option]')].find(el=>el.textContent.includes(label)).click();await wait(60)};
const open=async(scope,index)=>{const model=[...scope.querySelectorAll('.pf-model')][index];model.querySelector('.pf-model-toggle').click();await until(()=>model.classList.contains('open'),'a model to open');await wait(40);return model};
try {
 setLang('en');
 render(h(ProvidersPage,{}),document.getElementById('app'));
 await until(()=>item('Relay'),'the list');

 // One row for the provider, none for its keys; red, because one of its models has no format on any layer.
 check(!item('Cheap group')&&!item('Fast group'),'a key has a row of its own');
 check(item('Relay').textContent.includes('2 keys')&&item('Relay').textContent.includes('2 models'),'the row does not count: '+item('Relay').textContent);
 check(item('Relay').querySelector('.dot.danger'),'the row of a provider with a model not set up is not red');
 check(item('solo').querySelector('.dot.ok'),'a provider set up completely is not green');

 item('Relay').click();
 await until(()=>document.querySelector('.prov-global'),'the global settings');
 check(document.querySelectorAll('.prov-key').length===2,'both keys are not listed');
 check(document.querySelector('.prov-head .badge.danger'),'the head does not say something is not set up');
 check(card('relay-fast').querySelector('.prov-key-head .badge.danger').textContent.includes('1 model'),'the key does not count what is not set up');
 check(card('relay-cheap').querySelector('.prov-key-head .badge.ok'),'a key set up completely is not green');
 check(!document.body.textContent.includes('Hidden'),'something hidden is shown');

 check(!document.body.textContent.includes('C:/somewhere'),'the page shows the path of models.json');

 // Everything starts folded, and a folded key does not show the end of its API key.
 check(document.querySelector('.prov-global .set-card-toggle').getAttribute('aria-expanded')==='false','the global settings start open');
 check(!fieldOf(document.querySelector('.prov-global'),'Base URL'),'folded global settings still show their fields');
 check([...document.querySelectorAll('.prov-key-toggle')].every(el=>el.getAttribute('aria-expanded')==='false'),'a key starts open');
 check(!card('relay-cheap').textContent.includes('aaaa'),'a folded key shows the end of its API key');

 // What the global settings fill in greys the same field below, which keeps its own value and says why.
 card('relay-cheap').querySelector('.prov-key-toggle').click();
 await until(()=>card('relay-cheap').querySelector('.pf-fields'),'the form of a key');
 const cheap=card('relay-cheap');
 const url=fieldOf(cheap,'Base URL');
 check(url.querySelector('input').disabled,'a covered address can be edited');
 check(url.querySelector('input').value==='https://own.example/v1','a covered address lost its own value');
 check(url.textContent.includes('Covered by the global settings')&&url.textContent.includes('https://top.example/v1'),'a covered address does not say so: '+url.textContent);
 const area=cheap.querySelector('.pf-key-area');
 check(area.classList.contains('covered'),'a covered API key is not grey');
 check(area.textContent.includes('aaaa')&&area.textContent.includes('gggg'),'the API key area names neither key: '+area.textContent);
 const format=fieldOf(cheap,'API format');
 check(!format.querySelector('button.select-like').disabled,'a format nothing covers cannot be changed');

 const cheapModel=await open(cheap,0);
 const modelUrl=fieldOf(cheapModel,'Base URL');
 check(modelUrl.querySelector('input').disabled&&modelUrl.querySelector('input').value==='https://model.example','a model lost its covered address');
 check(modelUrl.textContent.includes('Covered by the global settings'),'a model does not say what covers it: '+modelUrl.textContent);
 const modelKey=cheapModel.querySelector('.key-current');
 check(modelKey.classList.contains('covered')&&modelKey.textContent.includes('mmmm'),'the key of a model is not shown as covered');

 // No layer sets the format: red, with nothing guessed for it.
 card('relay-fast').querySelector('.prov-key-toggle').click();
 await until(()=>card('relay-fast').querySelector('.pf-fields'),'the second form');
 const fast=card('relay-fast');
 check(fast.querySelector('.pf-model .badge.danger').textContent.includes('No format'),'a model no layer sets a format for is not marked');
 const fastModel=await open(fast,0);
 check(fieldOf(fastModel,'API format').textContent.includes('Not set here'),'a format was guessed');
 check(fieldOf(fastModel,'API format').textContent.includes('No layer sets the format'),'it does not say why it is red');

 // A value on top of keys that differ warns before it replaces them, and only while being edited.
 document.querySelector('.prov-global .set-card-toggle').click();
 await until(()=>fieldOf(document.querySelector('.prov-global'),'Base URL'),'the global settings to open');
 const global=document.querySelector('.prov-global');
 const globalUrl=fieldOf(global,'Base URL');
 check(!globalUrl.textContent.includes('different addresses'),'it warns before anything is edited');
 type(globalUrl.querySelector('input'),'https://other.example/v1');
 await until(()=>fieldOf(document.querySelector('.prov-global'),'Base URL').textContent.includes('different addresses'),'the warning');
 check(fieldOf(document.querySelector('.prov-global'),'Base URL').textContent.includes('https://own.example/v1'),'the warning does not name the addresses');
 type(fieldOf(document.querySelector('.prov-global'),'Base URL').querySelector('input'),'');
 await until(()=>!fieldOf(document.querySelector('.prov-global'),'Base URL').textContent.includes('different addresses'),'the warning to go');
 document.querySelector('.prov-global .prov-global-foot .btn.primary').click();
 const globalSent=await lastSent('/api/providers/group/save',1);
 check(globalSent.id==='relay'&&globalSent.baseUrl===''&&globalSent.name==='Relay'&&globalSent.removeApiKey===false,'the global save sent '+JSON.stringify(globalSent));
 await until(()=>!document.querySelector('.prov-global-foot'),'the global save to finish');

 // Moving a key out sends just that, and asks nothing: it keeps what it uses.
 card('relay-fast').querySelector('.prov-key-head .icon-btn').click();
 const leaveSent=await lastSent('/api/providers/group/leave',1);
 check(leaveSent.id==='relay-fast','moving out sent '+JSON.stringify(leaveSent));
 await until(()=>card('relay-fast'),'the page to come back');

 // A format set on the ticked models moves the value of the key down onto the models not ticked.
 item('solo').click();
 await until(()=>card('solo'),'the single key');
 check(card('solo').querySelector('.prov-key-toggle').getAttribute('aria-expanded')==='false','a single key starts open');
 card('solo').querySelector('.prov-key-toggle').click();
 await until(()=>card('solo').querySelector('.pf-fields'),'the form of a single key');
 const solo=card('solo');
 check(!solo.querySelector('.prov-key-head button.toggle'),'a single key has a second switch');
 check(document.querySelector('.prov-global'),'a provider of one key has no global settings');
 const ticks=[...solo.querySelectorAll('.pf-tick')];
 check(ticks.length===2,'models cannot be ticked');
 ticks[1].click();
 await until(()=>card('solo').querySelector('.pf-batch-fields'),'the batch fields');
 await choose(solo.querySelector('.pf-batch-fields button.select-like'),'Anthropic');
 solo.querySelector('.pf-batch-fields .btn').click();
 await until(()=>card('solo').querySelector('.pf-batch [role=status]'),'the note about the moved value');
 card('solo').querySelector('.pf-foot .btn.primary').click();
 const batchSent=await lastSent('/api/providers/custom/save',1);
 check(batchSent.id==='solo','the batch saved '+batchSent.id);
 check(!batchSent.config.api,'the key still holds the format: '+batchSent.config.api);
 check(batchSent.config.models[0].api==='openai-completions','the model not ticked changed: '+batchSent.config.models[0].api);
 check(batchSent.config.models[1].api==='anthropic-messages','the ticked model did not change: '+batchSent.config.models[1].api);
 check(batchSent.config.baseUrl==='https://solo.example/v1'&&!batchSent.config.models[1].baseUrl,'the address changed as well');
 await until(()=>!card('solo').querySelector('.pf-foot .btn:not(.primary):not(.danger)'),'the save to finish');
 // The page learns that the form is clean in an effect, which runs a moment after the form is drawn.
 await wait(200);

 // Only one model has a key: that key is not covered by anything, the other model is red, and a typed key goes with the save.
 item('model-only').click();
 await until(()=>card('model-only'),'the entry with model keys');
 card('model-only').querySelector('.prov-key-toggle').click();
 await until(()=>card('model-only').querySelector('.pf-fields'),'the form of the entry with model keys');
 const only=card('model-only');
 check(only.querySelector('.prov-key-head .badge.danger').textContent.includes('1 model'),'the key does not count the model without a key');
 const [withKey,withoutKey]=[...only.querySelectorAll('.pf-model')];
 check(!withKey.querySelector('.badge.danger'),'the model with its own key is marked');
 check(withoutKey.querySelector('.badge.danger').textContent.includes('No API key'),'the model without a key is not marked');
 const own=await open(only,0);
 check(!own.querySelector('.key-current').classList.contains('covered'),'the only key there is shows as covered');
 check(own.querySelector('.key-current').textContent.includes('wwww'),'the key of the model is not named');
 const needs=await open(only,1);
 const needsKey=needs.querySelector('input[type=password]');
 check(!needsKey.disabled,'a model that needs a key cannot be given one');
 type(needsKey,'sk-typed-key');
 await until(()=>!card('model-only').querySelectorAll('.pf-model')[1].querySelector('.badge.danger'),'the red to go');
 card('model-only').querySelector('.pf-foot .btn.primary').click();
 const keySent=await lastSent('/api/providers/custom/save',2);
 check(keySent.id==='model-only'&&keySent.modelKeys?.['without-key']==='sk-typed-key','the typed key was not sent: '+JSON.stringify(keySent.modelKeys));
 check(!JSON.stringify(keySent.config).includes('sk-typed-key'),'the typed key would be written to models.json');
 check(!('with-key' in keySent.modelKeys),'the untouched key is sent');
 await until(()=>!card('model-only').querySelector('.pf-foot .btn:not(.primary):not(.danger)'),'the second save to finish');
 await wait(200);

 // An entry outside the layers keeps its old form.
 item('overlay').click();
 await until(()=>document.querySelector('.prov-head .prov-title')?.textContent==='overlay','the old form');
 check(!document.querySelector('.prov-global')&&!document.querySelector('.prov-key')&&!document.querySelector('.pf-tick'),'an entry outside the layers got them');

 // The suggestion only offers: what is sure is ticked, what only looks related is not, and merging sends just the ticks.
 check(document.querySelector('.prov-suggest .set-card-toggle').getAttribute('aria-expanded')==='false','the suggestion is open by itself');
 document.querySelector('.prov-suggest .set-card-toggle').click();
 await until(()=>document.querySelector('.prov-suggest .set-card-toggle').getAttribute('aria-expanded')==='true','the suggestion to open');
 const rows=[...document.querySelectorAll('.prov-suggest-row')];
 check(rows.map(row=>row.querySelector('input').checked).join()==='true,true,false','what is ticked first: '+rows.map(row=>row.querySelector('input').checked));
 check(rows[2].textContent.includes('may be the same')&&!rows[0].textContent.includes('may be the same'),'what only looks related is not said to');
 type(document.querySelector('.prov-suggest-foot input'),'Relay Two');
 await wait(40);
 document.querySelector('.prov-suggest-foot .btn.primary').click();
 const mergeSent=await lastSent('/api/providers/group/merge',1);
 check(mergeSent.ids.join()==='solo,model-only'&&mergeSent.name==='Relay Two','the merge sent '+JSON.stringify(mergeSent));
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Provider layers test",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			const outcome = page.text.match(/id="ready">([^<]*)/)?.[1];
			expect(outcome, outcome).toBe("passed");
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	120000,
);
