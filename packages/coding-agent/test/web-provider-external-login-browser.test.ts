import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { HttpError, WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"uses an external sign-in without asking for an API key, rechecks its actual status, and keeps API key login available",
	async () => {
		const temporary =
			process.env.MYHARNESS_TEMP_DIR ||
			(process.env.MYHARNESS_ARTIFACTS_DIR ? join(process.env.MYHARNESS_ARTIFACTS_DIR, "temporary") : undefined);
		if (!temporary) throw new Error("MYHARNESS_TEMP_DIR or MYHARNESS_ARTIFACTS_DIR is required for browser fixtures");
		mkdirSync(temporary, { recursive: true });
		const root = mkdtempSync(join(temporary, "myharness-external-login-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((candidate) => candidate.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		// These are display-only fixtures: no Claude process, external provider or real account is used.
		const externalLogin = {
			instructions: "Use the provider-owned fixture profile to sign in.\nThen return here to check that profile.",
			command: 'fixture-claude-code --config-dir "C:\\fixture profile" auth login --browser',
		};
		const model = {
			id: "external-login-fixture-model",
			name: "External login fixture model",
			provider: "claude-code",
		};
		const checkBodies: unknown[] = [];
		const checkResults: boolean[] = [];
		const reads: { resource: "providers" | "models"; check: number; configured: boolean }[] = [];
		const unexpectedRequests: string[] = [];
		let configured = false;
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/providers", () => {
				reads.push({ resource: "providers", check: checkBodies.length, configured });
				return {
					providers: [
						{
							id: "claude-code",
							name: "Claude Code",
							enabled: true,
							missingBaseUrl: false,
							configured,
							authSource: configured ? "environment" : null,
							baseUrl: "claude-code://local",
							modelCount: configured ? 1 : 0,
							supportsApiKeyLogin: false,
							supportsOAuth: false,
							externalLogin,
							custom: false,
							credentials: null,
						},
						{
							id: "fixture-api-key",
							name: "API key fixture",
							enabled: true,
							missingBaseUrl: false,
							configured: false,
							authSource: null,
							baseUrl: "https://provider-fixture.invalid/v1",
							modelCount: 0,
							supportsApiKeyLogin: true,
							supportsOAuth: false,
							custom: false,
							credentials: { active: null, apiKeys: [], hasOAuth: false, runtimeOverride: false },
						},
					],
					modelsPath: null,
					error: null,
				};
			});
			server.route("POST", "/api/providers/auth/check", ({ body }) => {
				checkBodies.push(body);
				if ((body as { id?: string } | undefined)?.id !== "claude-code")
					throw new HttpError(400, "Only the fixture external provider can be checked");
				if (checkBodies.length > 2) throw new HttpError(400, "Unexpected extra sign-in check");
				configured = checkBodies.length === 2;
				checkResults.push(configured);
				return { ok: true, configured };
			});
			server.route("GET", "/api/providers/custom", () => ({
				path: null,
				apiTypes: ["openai-completions"],
				connectionDefaults: {},
				providers: [],
				groups: [],
				mergeSuggestions: [],
				hiddenPlaceholder: "",
			}));
			server.route("GET", "/api/providers/nebius", () => ({ configured: false, spend: null }));
			server.route("GET", "/api/models", () => {
				reads.push({ resource: "models", check: checkBodies.length, configured });
				return { models: configured ? [model] : [] };
			});
			for (const method of ["GET", "POST", "PUT", "DELETE"] as const)
				server.route(method, "/api/*", ({ url }) => {
					unexpectedRequests.push(`${method} ${url.pathname}`);
					throw new HttpError(404, "Unexpected fixture API request");
				});
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
import {state,subscribe} from '/js/store.js';
import {setLang} from '/js/lang.js';
const fixture=${JSON.stringify({ externalLogin, model })};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,message)=>{if(!ok)throw Error(message)};
const until=async(fn,message)=>{for(let i=0;i<150;i++){if(await fn())return;await wait(40)}throw Error(message||'timed out waiting for the UI')};
const visible=el=>!!el&&el.isConnected&&!el.closest('[hidden],[inert]')&&getComputedStyle(el).visibility!=='hidden'&&el.getClientRects().length>0;
const detail=()=>document.querySelector('.prov-detail');
const button=label=>[...(detail()?.querySelectorAll('button')||[])].find(el=>visible(el)&&[el.textContent.trim(),el.getAttribute('aria-label'),el.getAttribute('title')].includes(label));
const item=id=>[...document.querySelectorAll('.prov-item')].find(el=>el.querySelector('.prov-item-sub')?.textContent.trim()===id);
const provider=()=>state.providers?.providers.find(p=>p.id==='claude-code');
const badges=()=>[...detail().querySelectorAll('.prov-head .badge')].map(el=>el.textContent.trim());
const command=()=>detail()?.querySelector('textarea[aria-label="Sign-in command"]');
const noKeyUI=()=>{
 check(!detail().textContent.includes('No API key'),'external sign-in is described as a missing API key');
 check(!detail().textContent.includes('Add API key'),'external sign-in offers the API key manager');
 check(!detail().querySelector('input[type="password"]'),'external sign-in asks for a password or API key');
};
const checkInstructions=()=>{
 const field=command();
 check(visible(field),'the independent sign-in command is not visible');
 check(field.readOnly,'the sign-in command is editable');
 check(!field.disabled,'the sign-in command is disabled instead of selectable');
 check(field.value===fixture.externalLogin.command,'the complete sign-in command was changed or truncated: '+field.value);
 const instructions=[...detail().querySelectorAll('.pf-hint')].find(el=>el.textContent===fixture.externalLogin.instructions);
 check(visible(instructions),'the provider-supplied independent sign-in instructions are missing');
 check(button('Copy command'),'Copy command is missing');
 check(button('Check sign-in status'),'Check sign-in status is missing');
 noKeyUI();
};
const copied=[];
const signedInToasts=new Set();
let stop=()=>{};
try {
 // Observe CopyButton without reading or changing the operating system clipboard.
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copied.push(text)}}});
 stop=subscribe(()=>{for(const toast of state.toasts)if(toast.message==='Signed in')signedInToasts.add(toast.id)});
 setLang('en');
 render(h(ProvidersPage,{}),document.getElementById('app'));
 await until(()=>item('claude-code')&&item('fixture-api-key'),'the fixture providers were not listed');
 item('claude-code').click();
 await until(()=>button('Sign in'),'Claude Code has no Sign in button');
 check(provider()?.supportsApiKeyLogin===false&&provider()?.supportsOAuth===false,'external sign-in exposes an API key or OAuth capability');
 check(provider()?.externalLogin?.command===fixture.externalLogin.command,'externalLogin did not reach the provider store');
 check(provider()?.configured===false,'the fixture starts configured');
 check(badges().includes('Not signed in')&&!badges().includes('Ready'),'Claude Code is not shown as Not signed in');
 check(detail().querySelector('.key-current')?.textContent.includes('Not signed in'),'the external sign-in area does not report Not signed in');
 check(item('claude-code').querySelector('.dot')?.title==='Not signed in','the provider list still reports the wrong missing-credential status');
 check(!visible(command()),'the sign-in command starts expanded');
 noKeyUI();
 button('Sign in').click();
 await until(()=>visible(command()),'Sign in did not expand the independent instructions');
 checkInstructions();
 button('Copy command').click();
 await until(()=>copied.length===1,'Copy command did not write to the clipboard adapter');
 check(copied[0]===fixture.externalLogin.command,'Copy command did not copy the complete, unchanged command');
 // The first POST succeeds as a request, but the fixture profile is still signed out.
 button('Check sign-in status').click();
 await until(()=>state.models!==null&&button('Check sign-in status')&&!button('Check sign-in status').disabled,'the signed-out check did not finish refreshing models');
 check(provider()?.configured===false,'configured:false was turned into a successful sign-in');
 check(badges().includes('Not signed in')&&!badges().includes('Ready'),'the signed-out check falsely marked Claude Code Ready');
 check(detail().querySelector('.key-current')?.textContent.includes('Not signed in'),'the signed-out check falsely marked the external sign-in area Signed in');
 check(item('claude-code').querySelector('.dot')?.title==='Not signed in','the signed-out list status was lost');
 check(signedInToasts.size===0,'an ok:true/configured:false response produced a Signed in success message');
 check(state.models.models.length===0,'signed-out provider models were published');
 checkInstructions();
 // A later check now reports a configured profile; both the row and shared model list must refresh.
 button('Check sign-in status').click();
 await until(()=>provider()?.configured===true&&badges().includes('Ready')&&state.models?.models.some(m=>m.id===fixture.model.id&&m.provider===fixture.model.provider),'a signed-in check did not update provider.configured, Ready and the model list');
 await until(()=>button('Check sign-in status')&&!button('Check sign-in status').disabled,'the signed-in check stayed busy');
 check(!badges().includes('Not signed in'),'the header still reports Not signed in after a configured check');
 check(item('claude-code').querySelector('.dot')?.title==='Ready','the provider list did not become Ready');
 noKeyUI();
 // The external-login branch must not remove normal API key login from other providers.
 item('fixture-api-key').click();
 await until(()=>button('Add API key'),'an ordinary API key provider lost Add API key');
 check(!button('Sign in')&&!button('Check sign-in status')&&!visible(command()),'the external-login panel leaked into an API key provider');
 button('Add API key').click();
 await until(()=>visible(detail().querySelector('input[type="password"][aria-label="API key"]')),'Add API key did not open the key form');
 const keyInput=detail().querySelector('input[type="password"][aria-label="API key"]');
 check(!keyInput.readOnly&&!keyInput.disabled&&keyInput.value==='','the ordinary API key form is not editable and initially empty');
 check(button('Save key')?.disabled===true,'an empty API key can be saved');
 check([...detail().querySelectorAll('.set-card-head strong')].some(el=>el.textContent.trim()==='Add API key'),'the Add API key form heading is missing');
 const result=document.createElement('p');result.id='ready';result.textContent='passed';document.body.append(result);
} catch(error) {
 const result=document.createElement('pre');result.id='ready';result.textContent=error.stack||String(error);document.body.append(result);
} finally {stop();}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Provider external sign-in browser regression",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
			expect(checkBodies).toEqual([{ id: "claude-code" }, { id: "claude-code" }]);
			expect(checkResults).toEqual([false, true]);
			for (const round of [1, 2]) {
				for (const resource of ["providers", "models"] as const)
					expect(reads).toContainEqual({ resource, check: round, configured: round === 2 });
			}
			expect(unexpectedRequests).toEqual([]);
		} finally {
			try {
				await browser.shutdown();
			} finally {
				try {
					await server.close();
				} finally {
					rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
				}
			}
		}
	},
	120000,
);
