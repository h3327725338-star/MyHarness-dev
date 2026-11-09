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

 // Everything starts folded. A folded key says in one line what it uses from the top down: the address and the key of
 // the provider settings cover its own, so those are shown, never the key it keeps underneath.
 check(document.querySelector('.prov-global .prov-group-row').getAttribute('aria-expanded')==='false','the provider settings start open');
 check(!fieldOf(document.querySelector('.prov-global'),'Base URL'),'folded provider settings still show their fields');
 check(document.querySelector('.prov-global .prov-group-chips').textContent.includes('top.example/v1'),'the folded provider settings do not say what they set: '+document.querySelector('.prov-global .prov-group-chips').textContent);
 check([...document.querySelectorAll('.prov-key-toggle')].every(el=>el.getAttribute('aria-expanded')==='false'),'a key starts open');
 const cheapSum=card('relay-cheap').querySelector('.prov-key-sum').textContent;
 check(cheapSum.includes('OpenAI Chat')&&cheapSum.includes('top.example/v1')&&cheapSum.includes('\\u2022\\u2022\\u2022\\u2022gggg'),'the folded key does not say what it uses: '+cheapSum);
 check(!card('relay-cheap').textContent.includes('aaaa'),'a folded key shows the API key the provider settings cover');
 // Rows that fold are not text: a quick second click must not highlight them.
 for (const row of [card('relay-cheap').querySelector('.prov-key-head'),document.querySelector('.prov-global .prov-group-row')]) check(getComputedStyle(row).userSelect==='none','a row that folds can be selected as text');
 // Deleting is not next to anything that saves: it is in the row's ⋯ menu.
 check(!card('relay-cheap').querySelector('.prov-key-head .icon-btn:not(.prov-more)'),'a key row has a loose action button');
 card('relay-cheap').querySelector('.prov-more').click();
 await until(()=>document.querySelector('.popover [role=menuitem]'),'the key menu');
 const keyMenu=[...document.querySelectorAll('.popover [role=menuitem]')].map(el=>el.textContent.trim());
 check(keyMenu.join('|')==='Manage API keys|Edit as JSON (advanced)|Move out of this provider|Delete this key','the key menu holds: '+keyMenu.join('|'));
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 await until(()=>!document.querySelector('.popover:not(.closing)'),'the key menu to close');

 // What the provider settings fill in greys the same field below, which keeps its own value and says why.
 card('relay-cheap').querySelector('.prov-key-toggle').click();
 await until(()=>card('relay-cheap').querySelector('.pf-fields'),'the form of a key');
 const cheap=card('relay-cheap');
 check(!document.querySelector('.prov-savebar'),'the save bar shows before anything changed');
 const url=fieldOf(cheap,'Base URL');
 check(url.querySelector('input').disabled,'a covered address can be edited');
 check(url.querySelector('input').value==='https://own.example/v1','a covered address lost its own value');
 check(url.textContent.includes('Covered by the provider settings')&&url.textContent.includes('https://top.example/v1'),'a covered address does not say so: '+url.textContent);
 const area=cheap.querySelector('.pf-key-area');
 check(area.classList.contains('covered'),'a covered API key is not grey');
 check(area.textContent.includes('aaaa')&&area.textContent.includes('gggg'),'the API key area names neither key: '+area.textContent);
 const format=fieldOf(cheap,'API format');
 check(!format.querySelector('button.select-like').disabled,'a format nothing covers cannot be changed');

 const cheapModel=await open(cheap,0);
 const modelUrl=fieldOf(cheapModel,'Base URL');
 check(modelUrl.querySelector('input').disabled&&modelUrl.querySelector('input').value==='https://model.example','a model lost its covered address');
 check(modelUrl.textContent.includes('Covered by the provider settings'),'a model does not say what covers it: '+modelUrl.textContent);
 const modelKey=cheapModel.querySelector('.key-current');
 check(modelKey.classList.contains('covered')&&modelKey.textContent.includes('mmmm'),'the key of a model is not shown as covered');
 // Under the model: what it really uses, and from which layer.
 const uses=cheapModel.querySelector('.pf-uses').textContent;
 check(uses.includes('top.example/v1')&&uses.includes('\\u2190 provider')&&uses.includes('gggg'),'the model does not say what it uses: '+uses);

 // No layer sets the format: red, with nothing guessed for it. Opening a second key folds the first.
 card('relay-fast').querySelector('.prov-key-toggle').click();
 await until(()=>card('relay-fast').querySelector('.pf-fields'),'the second form');
 check(card('relay-cheap').querySelector('.prov-key-toggle').getAttribute('aria-expanded')==='false','two keys are open at once');
 const fast=card('relay-fast');
 check(fast.querySelector('.pf-model .badge.danger').textContent.includes('No format'),'a model no layer sets a format for is not marked');
 const fastModel=await open(fast,0);
 check(fieldOf(fastModel,'API format').textContent.includes('Not set here'),'a format was guessed');
 check(fieldOf(fastModel,'API format').textContent.includes('No layer sets the format'),'it does not say why it is red');

 // A value on top of keys that differ warns before it replaces them, and only while being edited.
 document.querySelector('.prov-global .prov-group-row').click();
 await until(()=>fieldOf(document.querySelector('.prov-global'),'Base URL'),'the global settings to open');
 const global=document.querySelector('.prov-global');
 const globalUrl=fieldOf(global,'Base URL');
 check(!globalUrl.textContent.includes('different addresses'),'it warns before anything is edited');
 const startUrl=globalUrl.querySelector('input').value;
 check(startUrl!=='','the provider settings of the fixture set no address');
 type(globalUrl.querySelector('input'),'https://other.example/v1');
 await until(()=>fieldOf(document.querySelector('.prov-global'),'Base URL').textContent.includes('different addresses'),'the warning');
 check(fieldOf(document.querySelector('.prov-global'),'Base URL').textContent.includes('https://own.example/v1'),'the warning does not name the addresses');
 type(fieldOf(document.querySelector('.prov-global'),'Base URL').querySelector('input'),'');
 await until(()=>!fieldOf(document.querySelector('.prov-global'),'Base URL').textContent.includes('different addresses'),'the warning to go');
 // Typed back to what it was, nothing is unsaved: the bar and the dot go, and come back with the next change.
 await until(()=>document.querySelector('.prov-savebar.shown')&&document.querySelector('.prov-global .prov-dirty'),'the save bar and the dot of the change');
 type(fieldOf(document.querySelector('.prov-global'),'Base URL').querySelector('input'),startUrl);
 await until(()=>!document.querySelector('.prov-savebar.shown')&&!document.querySelector('.prov-global .prov-dirty'),'the save bar and the dot to go once the address is typed back');
 type(fieldOf(document.querySelector('.prov-global'),'Base URL').querySelector('input'),'');
 // One save bar for the whole provider, saying where the change is; it holds no delete.
 const bar=await until(()=>document.querySelector('.prov-savebar.shown'),'the save bar');
 check(bar.textContent.includes('Provider settings has unsaved changes'),'the save bar does not say where the change is: '+bar.textContent);
 check(document.querySelectorAll('.prov-savebar').length===1&&!bar.querySelector('.danger'),'there is more than one save bar, or it can delete');
 bar.querySelector('.btn.primary').click();
 const globalSent=await lastSent('/api/providers/group/save',1);
 check(globalSent.id==='relay'&&globalSent.baseUrl===''&&globalSent.name==='Relay'&&globalSent.removeApiKey===false,'the provider settings save sent '+JSON.stringify(globalSent));
 await until(()=>!document.querySelector('.prov-savebar.shown'),'the provider settings save to finish');

 // Adding a key folds the open one, unfolds the new one in view with its name ready to type, and the bar adds it.
 document.querySelector('.prov-add-key').click();
 const fresh=await until(()=>document.querySelector('.prov-new .pf-fields'),'the new key');
 check([...document.querySelectorAll('.prov-key-toggle')].every(el=>el.getAttribute('aria-expanded')==='false'),'a key stays open while one is added');
 await until(()=>fresh.contains(document.activeElement)&&document.activeElement.matches('input:not(.pf-id-input)'),'the name of the new key to take the keyboard');
 const addBar=await until(()=>document.querySelector('.prov-savebar.shown'),'the bar of the new key');
 check(addBar.textContent.includes('The new key is not added yet')&&addBar.querySelector('.btn.primary').textContent.includes('Add key'),'the bar does not offer to add the key: '+addBar.textContent);
 [...addBar.querySelectorAll('.btn')].find(el=>el.textContent.includes('Cancel')).click();
 await until(()=>!document.querySelector('.prov-new')&&!document.querySelector('.prov-savebar'),'the new key to go');

 // Moving a key out sends just that, and asks nothing: it keeps what it uses.
 card('relay-fast').querySelector('.prov-more').click();
 await until(()=>document.querySelector('.popover [role=menuitem]'),'the key menu');
 [...document.querySelectorAll('.popover [role=menuitem]')].find(el=>el.textContent.includes('Move out')).click();
 const leaveSent=await lastSent('/api/providers/group/leave',1);
 check(leaveSent.id==='relay-fast','moving out sent '+JSON.stringify(leaveSent));
 await until(()=>card('relay-fast'),'the page to come back');

 // A key that stands alone is the provider itself: no key level, its connection in the provider's card.
 item('solo').click();
 await until(()=>document.querySelector('.prov-head .prov-title')?.textContent==='solo'&&document.querySelector('.prov-root .pf-conn'),'the provider of one key');
 check(!document.querySelector('.prov-key')&&!document.querySelector('.prov-global'),'a provider of one key shows the key level or provider settings');
 check(fieldOf(document.querySelector('.prov-root'),'Base URL').querySelector('input').value==='https://solo.example/v1','the connection is not in the provider card');
 check(document.querySelectorAll('.prov-root-head button.toggle').length===1,'a provider of one key has a second switch');
 check(document.querySelector('.prov-add-row').textContent.includes('With a second key'),'adding a key does not say what it changes');
 // A change typed back by hand leaves nothing unsaved: the bar rises with it and sinks again.
 const soloUrl=fieldOf(document.querySelector('.prov-root'),'Base URL').querySelector('input');
 type(soloUrl,'https://solo.example/v2');
 await until(()=>document.querySelector('.prov-savebar.shown'),'the save bar of the changed address');
 type(soloUrl,'https://solo.example/v1');
 await until(()=>!document.querySelector('.prov-savebar.shown'),'the save bar to sink once the address is typed back');
 // A format set on the ticked models moves the value of the key down onto the models not ticked.
 const solo=document.querySelector('.prov-detail');
 const ticks=[...solo.querySelectorAll('.pf-tick')];
 check(ticks.length===2,'models cannot be ticked');
 ticks[1].click();
 await until(()=>solo.querySelector('.pf-batch-fields'),'the batch fields');
 await choose(solo.querySelector('.pf-batch-fields button.select-like'),'Anthropic');
 solo.querySelector('.pf-batch-fields .btn').click();
 await until(()=>solo.querySelector('.pf-batch [role=status]'),'the note about the moved value');
 (await until(()=>document.querySelector('.prov-savebar.shown .btn.primary'),'the save bar')).click();
 const batchSent=await lastSent('/api/providers/custom/save',1);
 check(batchSent.id==='solo','the batch saved '+batchSent.id);
 check(!batchSent.config.api,'the key still holds the format: '+batchSent.config.api);
 check(batchSent.config.models[0].api==='openai-completions','the model not ticked changed: '+batchSent.config.models[0].api);
 check(batchSent.config.models[1].api==='anthropic-messages','the ticked model did not change: '+batchSent.config.models[1].api);
 check(batchSent.config.baseUrl==='https://solo.example/v1'&&!batchSent.config.models[1].baseUrl,'the address changed as well');
 await until(()=>!document.querySelector('.prov-savebar.shown'),'the save to finish');
 // The page learns that the form is clean in an effect, which runs a moment after the form is drawn.
 await wait(200);

 // Only one model has a key: that key is not covered by anything, the other model is red, and a typed key goes with the save.
 item('model-only').click();
 await until(()=>document.querySelector('.prov-head .prov-title')?.textContent==='model-only'&&document.querySelector('.prov-root .pf-conn'),'the entry with model keys');
 const only=document.querySelector('.prov-detail');
 check(document.querySelector('.prov-head .badge.danger').textContent.includes('1 model'),'the provider does not count the model without a key');
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
 await until(()=>!only.querySelectorAll('.pf-model')[1].querySelector('.badge.danger'),'the red to go');
 (await until(()=>document.querySelector('.prov-savebar.shown .btn.primary'),'the save bar')).click();
 const keySent=await lastSent('/api/providers/custom/save',2);
 check(keySent.id==='model-only'&&keySent.modelKeys?.['without-key']==='sk-typed-key','the typed key was not sent: '+JSON.stringify(keySent.modelKeys));
 check(!JSON.stringify(keySent.config).includes('sk-typed-key'),'the typed key would be written to models.json');
 check(!('with-key' in keySent.modelKeys),'the untouched key is sent');
 await until(()=>!document.querySelector('.prov-savebar.shown'),'the second save to finish');
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
