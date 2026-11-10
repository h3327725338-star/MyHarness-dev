import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// Pictures a reply shows inside its text (`![caption](path "layout")`): the real Markdown component and the real
// media route in a real browser. Checked on the page itself: each layout's place and size, that a reply that grows
// never shows an empty figure or asks for a picture twice, the large preview, the file menu, a file drawn again
// under the same name, and what is shown for a file that is not there.

/** A valid one-colour PNG of the given size. */
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
	const table = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (data: Buffer) => {
		let c = 0xffffffff;
		for (const byte of data) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc(body), body.length + 4);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
	const pixels = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(pixels)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const PAGE_SCRIPT = String.raw`
import {h,render} from '/vendor/preact.js';
import {Markdown} from '/js/markdown.js';
import {ImageLightboxHost} from '/js/lightbox.js';
const app=document.getElementById('app');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const waitFor=async(cond,what,timeoutMs=8000)=>{const start=Date.now();while(!cond()){if(Date.now()-start>timeoutMs)throw Error('timed out: '+what);await wait(25);}};
const figures=()=>[...document.querySelectorAll('.md-fig')];
const box=el=>el.getBoundingClientRect();
const show=text=>render(h('div',{},h(Markdown,{text}),h(ImageLightboxHost,{})),app);
const near=(a,b,by=1.5)=>Math.abs(a-b)<=by;
try {
 const dir=DIR;
 const filler='Text that flows beside the picture. '.repeat(70);
 const text='Block:\n\n![Wide chart]('+dir+'/My Drive/wide chart.png)\n\n![Side]('+dir+'/My Drive/square.png "right 40%")\n\n'+filler+'\n\n## Next\n\nRow:\n\n![a]('+dir+'/My Drive/wide chart.png)\n![b](My Drive/square.png)\n\nPress ![](My Drive/square.png "inline") here.\n\n![Gone]('+dir+'/nope.png "center")\n\n![web](https://example.com/logo.png)\n';
 show(text);
 await waitFor(()=>figures().length===6&&figures().every(f=>f.dataset.mediaState==='ready'||f.dataset.mediaState==='missing'),'figures filled');
 const [block,side,rowA,rowB,inline,gone]=figures();
 const width=box(document.querySelector('.md')).width;
 // On a line of its own: natural size, never wider than the reply; the caption under it at the picture's width.
 if(block.dataset.layout!=='block'||!near(box(block.querySelector('img')).width,300)) throw Error('block picture is not at its natural size: '+box(block.querySelector('img')).width);
 if(block.querySelector('.md-fig-cap')?.textContent!=='Wide chart'||!near(box(block.querySelector('.md-fig-cap')).width,box(block.querySelector('.md-fig-frame')).width,2.5)) throw Error('caption is not under the picture at its width');
 // At the right with the text flowing around it, at the width the reply asked for.
 if(getComputedStyle(side).float!=='right'||!near(box(side).width,width*0.4,2)) throw Error('wrapped picture: float '+getComputedStyle(side).float+', width '+box(side).width+' of '+width);
 const flowing=[...document.querySelectorAll('.md > p')].find(p=>p.textContent.startsWith('Text that flows'));
 if(!(box(flowing).top<box(side).bottom&&box(flowing).bottom>box(side).bottom)) throw Error('text does not flow around the picture');
 const range=document.createRange();range.selectNodeContents(flowing);
 const lines=[...range.getClientRects()];
 if(!lines.some(r=>r.right<=box(side).left+1&&r.top<box(side).bottom)||!lines.some(r=>r.top>=box(side).bottom&&r.right>box(side).left+20)) throw Error('lines beside the picture are not shortened, or lines below it are not full width');
 if(box(document.querySelector('.md h2')).top<box(side).bottom) throw Error('a heading did not start below the wrapped picture');
 // Two pictures of one paragraph: side by side, at one height, filling the row.
 if(!rowA.parentElement.classList.contains('md-fig-row')||rowB.parentElement!==rowA.parentElement) throw Error('pictures of one paragraph are not a row');
 const ia=box(rowA.querySelector('img')),ib=box(rowB.querySelector('img'));
 if(!near(ia.top,ib.top)||!near(ia.height,ib.height,2)||ib.left<ia.right) throw Error('row pictures: tops '+ia.top+'/'+ib.top+', heights '+ia.height+'/'+ib.height);
 if(!near(box(rowB).right,box(rowA.parentElement).right,1.5)) throw Error('row does not fill the width');
 // Inside a line of text, at text height, with no caption and no preview.
 const lineHeight=parseFloat(getComputedStyle(inline.parentElement).fontSize)*1.5;
 if(getComputedStyle(inline).display!=='inline-block'||!near(box(inline.querySelector('img')).height,lineHeight,1)||inline.querySelector('.md-fig-cap')||inline.querySelector('img').getAttribute('role')) throw Error('inline picture');
 if(box(inline).height>box(inline.parentElement).height+1) throw Error('inline picture makes its line taller than the paragraph');
 // A file that is not there, and an image on the web.
 if(gone.dataset.mediaState!=='missing'||!gone.textContent.includes('nope.png')||gone.querySelector('img')) throw Error('missing file is not shown as missing');
 if(document.querySelector('.md img[src^="http"]')||!document.querySelector('.md a[href="https://example.com/logo.png"]')) throw Error('a web image must stay a link');
 if(document.querySelector('.md-fig a')) throw Error('a caption or file name inside a figure became a file link');
 // The reply grows, as while it streams: every figure is made again, filled before the page could paint, with no new request.
 const requests=()=>performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/files/media')).length;
 const before=requests();
 let made=0,empty=0;
 const watch=new MutationObserver(()=>{for(const f of figures()){if(f.dataset.checked)continue;f.dataset.checked='1';made++;if(!f.dataset.mediaState||f.dataset.mediaState==='loading')empty++;}});
 watch.observe(app,{childList:true,subtree:true});
 let grown=text;
 // No timer between the steps (a hidden page's timers are slowed to a second each): only the observer gets its turn,
 // so the whole growth happens well inside the time a picture counts as just checked.
 for(let i=0;i<12;i++){grown+='\nmore '+i+'\n';show(grown);await null;await null;}
 watch.disconnect();
 if(made!==72||empty) throw Error('figures made again: '+made+', seen empty: '+empty);
 if(requests()!==before) throw Error('a growing reply asked for its pictures again: '+performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/files/media')).slice(before).map(e=>decodeURIComponent(e.name.split('path=')[1])+'@'+Math.round(e.startTime)).join(', '));
 // Click and Enter open the large preview with the same bytes; Escape closes it.
 const picture=figures()[0].querySelector('img');
 picture.click();
 await waitFor(()=>document.querySelector('.lightbox-scrim.open .lightbox-img'),'preview on click');
 if(document.querySelector('.lightbox-img').src!==picture.src) throw Error('preview shows other bytes');
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 await waitFor(()=>!document.querySelector('.lightbox-scrim.open'),'preview closed');
 picture.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 await waitFor(()=>document.querySelector('.lightbox-scrim.open'),'preview on Enter');
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 await waitFor(()=>!document.querySelector('.lightbox-scrim.open'),'preview closed again');
 // Right-click: the same menu a file link has.
 picture.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:60,clientY:60}));
 await waitFor(()=>document.querySelector('.local-file-menu')?.querySelectorAll('button').length>=2,'file menu');
 document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
 // The file is drawn again under the same name: the next look at it shows the new picture.
 const old=picture.src;
 await fetch('/api/test-redraw',{method:'POST',headers:{'x-myharness-web':'1','content-type':'application/json'},body:'{}'});
 await wait(5200);
 show(grown+'\nlast\n');
 await waitFor(()=>figures()[0].querySelector('img')?.src!==old,'changed file shown',6000);
 const fresh=figures()[0].querySelector('img');
 if(fresh.naturalWidth!==120||fresh.naturalHeight!==120) throw Error('changed file has the old size: '+fresh.naturalWidth+'x'+fresh.naturalHeight);
 // A column too narrow for text beside a picture: the picture takes a line of its own.
 app.style.width='380px';
 // Drawn in a narrow column, the picture is on a line of its own at once; in a wide one it is wrapped again. (While
 // the page stays up the same follows a change of width, which a hidden test page is never told about.)
 app.style.width='380px';
 show(grown+'\nnarrow\n');
 if(!figures()[1].hasAttribute('data-unwrapped')||getComputedStyle(figures()[1]).float!=='none'||box(figures()[1]).width>380) throw Error('picture not unwrapped in a narrow column');
 app.style.width='';
 show(grown+'\nwide\n');
 if(figures()[1].hasAttribute('data-unwrapped')||getComputedStyle(figures()[1]).float!=='right') throw Error('picture not wrapped again in a wide column');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {const p=document.createElement('p');p.id='ready';p.textContent=error.message+' | '+error.stack;document.body.append(p);}
`;

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"shows a reply's pictures in the layout the reply chose",
	async () => {
		const base = process.env.MYHARNESS_TEMP_DIR || tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "reply-media-"));
		const files = join(root, "files");
		mkdirSync(join(files, "My Drive"), { recursive: true });
		const wide = join(files, "My Drive", "wide chart.png");
		writeFileSync(wide, png(300, 100, [66, 133, 244]));
		writeFileSync(join(files, "My Drive", "square.png"), png(100, 100, [234, 67, 53]));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({ kind: installed[0]!.kind, rootDir: join(root, "browser") });
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
				'<!doctype html><html data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><style>html,body{height:auto;overflow:auto}#app{width:760px;margin:0 auto;font-size:15px}</style><div id="app"></div><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script></html>',
			);
			writeFileSync(join(root, "test.js"), PAGE_SCRIPT.replace("DIR", JSON.stringify(files.replaceAll("\\", "/"))));
			registerFileRoutes(server, { session: { sessionManager: { getCwd: () => files } } } as unknown as WebHost);
			server.route("POST", "/api/test-redraw", () => {
				writeFileSync(wide, png(120, 120, [52, 168, 83]));
				utimesSync(wide, new Date(), new Date(Date.now() + 2000));
				return { ok: true };
			});
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Pictures in a reply",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	120_000,
);
