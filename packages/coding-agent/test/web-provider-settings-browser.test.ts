import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { HttpError, WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"edits the values an extension provider stores itself, for the provider and for single models, and shows the provider's own message for a bad one",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-provider-settings-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((candidate) => candidate.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			let stored = "1M";
			let storedForBig = "";
			server.route("GET", "/api/providers", () => ({
				providers: [
					{
						id: "own-program",
						name: "Own program",
						enabled: true,
						missingBaseUrl: false,
						configured: true,
						authSource: "environment",
						baseUrl: "own://local",
						modelCount: 1,
						supportsApiKeyLogin: false,
						supportsOAuth: false,
						custom: false,
						authLabel: "the program's own login",
						models: [
							{ id: "big", name: "Own · Big", contextWindow: 1000000, levels: ["low", "high"], image: true },
							{ id: "plain", name: "Own · Plain", contextWindow: 200000, levels: [], image: false },
						],
						settings: [
							{
								id: "length",
								label: "Length",
								description: "Between 100K and 1M.",
								placeholder: "1M",
								model: null,
								value: stored,
							},
							{
								id: "length:big",
								label: "Model length",
								description: "For this model alone.",
								placeholder: "1M",
								model: "big",
								value: storedForBig,
							},
						],
						credentials: null,
					},
				],
				modelsPath: null,
				error: null,
			}));
			server.route("POST", "/api/providers/setting", ({ body }) => {
				const { id, setting, value } = body as { id: string; setting: string; value: string };
				if (id !== "own-program" || (setting !== "length" && setting !== "length:big"))
					throw new HttpError(404, "unknown setting");
				if (value === "5k") throw new HttpError(400, "Too short.");
				if (setting === "length") stored = value.toUpperCase();
				else storedForBig = value.toUpperCase();
				return { ok: true, value: value.toUpperCase() };
			});
			server.route("GET", "/api/providers/custom", () => ({
				path: null,
				apiTypes: [],
				connectionDefaults: {},
				providers: [],
				hiddenPlaceholder: "",
			}));
			server.route("GET", "/api/models", () => ({ models: [] }));
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
const until=async(fn)=>{for(let i=0;i<100;i++){if(await fn())return;await wait(40)}throw Error('timed out waiting for the UI')};
const type=(input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}))};
const field=()=>[...document.querySelectorAll('.field-label')].find(el=>el.textContent.includes('Length'));
const input=()=>field().querySelector('input');
const button=()=>field().querySelector('button');
try {
 setLang('en');
 render(h(ProvidersPage,{}),document.getElementById('app'));
 await until(()=>[...document.querySelectorAll('.prov-item')].some(el=>el.textContent.includes('Own program')));
 [...document.querySelectorAll('.prov-item')].find(el=>el.textContent.includes('Own program')).click();
 await until(()=>field());
 check(input().value==='1M','the stored value is not shown: '+input().value);
 check(button().disabled,'Save is on before anything changed');
 check(field().textContent.includes('Between 100K and 1M.'),'the description is missing');
 await wait(200);
 type(input(),'5k');
 await until(()=>!button().disabled);
 button().click();
 await wait(500);
 await until(()=>!button().disabled);
 check(input().value==='5k','a refused value was thrown away instead of staying to be corrected');
 type(input(),'300k');
 await until(()=>input().value==='300k');
 button().click();
 await until(()=>input().value==='300K');
 await until(()=>button().disabled);
 // The card: what signs the provider in, in its own words, and its models below it without the provider's name.
 check(document.querySelector('.prov-root').textContent.includes("the program's own login"),'the sign-in line is missing');
 const rows=()=>[...document.querySelectorAll('.pf-model-list .pf-model')];
 check(rows().map(el=>el.querySelector('.pf-model-title').textContent).join()==='Big,Plain','models: '+rows().map(el=>el.textContent).join());
 check(rows()[0].querySelector('.badge[title]').title==='low · high','the levels of a model are not named');
 check(!rows()[1].querySelector('.badge[title]'),'a model without levels shows a thinking badge');
 check(rows()[0].textContent.includes('1.0M')&&rows()[1].textContent.includes('200.0K'),'the context sizes are missing');
 // A model without a value of its own is a row that does not open; the other opens to its field.
 check(!rows()[1].querySelector('button'),'a row with nothing to set can be opened');
 const modelField=()=>[...document.querySelectorAll('.pf-model .field-label')].find(el=>el.textContent.includes('Model length'));
 check(!modelField(),'a model field is drawn before its row was opened');
 rows()[0].querySelector('button.pf-model-toggle').click();
 await until(()=>modelField());
 check(modelField().querySelector('input').value===''&&modelField().querySelector('input').placeholder==='1M','the model field does not start empty');
 type(modelField().querySelector('input'),'400k');
 await until(()=>!modelField().querySelector('button').disabled);
 check(rows()[0].querySelector('.prov-dirty'),'an unsaved value of a model is not marked on its row');
 modelField().querySelector('button').click();
 await until(()=>modelField().querySelector('input').value==='400K');
 await until(()=>!rows()[0].querySelector('.prov-dirty'));
 // Folded and opened again, the saved value is there; the provider's own value was not touched.
 rows()[0].querySelector('button.pf-model-toggle').click();
 await wait(400);
 rows()[0].querySelector('button.pf-model-toggle').click();
 await until(()=>modelField()&&modelField().querySelector('input').value==='400K');
 check(input().value==='300K','saving a model value changed the provider value: '+input().value);
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Provider settings render test",
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
