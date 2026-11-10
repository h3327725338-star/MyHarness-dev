import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const webDir = new URL("../web/js/", import.meta.url);
const model = await import(new URL("reply-media-model.js", webDir).href);
const { mediaKind, mediaName, parseMediaLayout, scanMedia } = model;
const { localLinkPath } = await import(new URL("local-file-links.js", webDir).href);

/** markdown.js as the page runs it, with the modules it imports handed in. */
function renderer(readOnly = false) {
	const context = vm.createContext({
		Component: class {},
		t: (text: string) => text,
		looseStrong: () => null,
		exportReadOnly: () => readOnly,
		localLinkPath,
		mediaName,
		parseMediaLayout,
		scanMedia,
	});
	vm.runInContext(readFileSync(new URL("../src/exports/html/vendor/marked.min.js", import.meta.url), "utf8"), context);
	const source = readFileSync(new URL("markdown.js", webDir), "utf8");
	vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), context);
	return context.renderMarkdown as (text: string) => string;
}
const B = String.fromCharCode(92);

describe("media syntax in a reply", () => {
	it("takes a Windows path as written: spaces, backslashes, brackets and angle brackets", () => {
		expect(scanMedia("![a](C:/Users/user/My Drive/week 5/p.png) after")).toMatchObject({
			raw: "![a](C:/Users/user/My Drive/week 5/p.png)",
			target: "C:/Users/user/My Drive/week 5/p.png",
			alt: "a",
			title: "",
			kind: "image",
		});
		const backslashes = `C:${B}Users${B}me${B}.cache${B}_out${B}p.png`;
		expect(scanMedia(`![a](${backslashes})`)?.target).toBe(backslashes);
		expect(scanMedia("![a](C:/t/p (1).png)")?.target).toBe("C:/t/p (1).png");
		expect(scanMedia("![a](<C:/t/My Drive/p.png>)")?.target).toBe("C:/t/My Drive/p.png");
		expect(scanMedia("![a](charts/p.png)")?.target).toBe("charts/p.png");
		expect(scanMedia("![a](file:///C:/t/p.png)")?.kind).toBe("image");
	});

	it("reads the layout words in the quotes after the path", () => {
		expect(scanMedia('![cap](C:/t/My Drive/p.png "right 40%") text')).toMatchObject({
			raw: '![cap](C:/t/My Drive/p.png "right 40%")',
			target: "C:/t/My Drive/p.png",
			title: "right 40%",
		});
		expect(scanMedia("![cap](C:/t/p.png 'center')")?.title).toBe("center");
		expect(parseMediaLayout("right 40%")).toEqual({ layout: "right", width: 40, title: "" });
		expect(parseMediaLayout("small LEFT")).toEqual({ layout: "left", width: 30, title: "" });
		expect(parseMediaLayout("full")).toEqual({ layout: "wide", width: undefined, title: "" });
		expect(parseMediaLayout("500%").width).toBe(100);
		expect(parseMediaLayout("")).toEqual({ layout: "block", width: undefined, title: "" });
		// Any other word makes it an ordinary title.
		expect(parseMediaLayout("Figure 1 right")).toEqual({
			layout: "block",
			width: undefined,
			title: "Figure 1 right",
		});
	});

	it("leaves everything that is not a local picture, video or sound to the standard rules", () => {
		expect(scanMedia("![a](https://example.com/p.png)")).toBeNull();
		expect(scanMedia("![a](data:image/png;base64,AAAA)")).toBeNull();
		expect(scanMedia("![a](//server/share/p.png)")).toBeNull();
		expect(scanMedia("![a](C:/t/notes.txt)")).toBeNull();
		expect(scanMedia("![a](C:/t/p.png")).toBeNull();
		expect(scanMedia("![a](C:/t/p.png\nmore)")).toBeNull();
		expect(scanMedia("![a] (C:/t/p.png)")).toBeNull();
		expect(mediaKind("C:/t/clip.MP4")).toBe("video");
		expect(mediaKind("C:/t/song.mp3")).toBe("audio");
		expect(mediaKind("/api/artifacts/download?path=ws%2Fs%2Fchart.png")).toBe("image");
		expect(mediaName("C:/t/My Drive/p (1).png")).toBe("p (1).png");
	});
});

describe("media in rendered Markdown", () => {
	it("writes a figure with its layout, width and caption for a local picture", () => {
		const html = renderer()(
			'Text before.\n\n![Slide 23](C:/Users/user/My Drive/s23.jpeg "right 35%")\n\nText after.',
		);
		expect(html).toContain('class="md-fig"');
		expect(html).toContain('data-layout="right"');
		expect(html).toContain('data-media-kind="image"');
		expect(html).toContain('data-media-src="C:/Users/user/My Drive/s23.jpeg"');
		expect(html).toContain('data-local-path="C:/Users/user/My Drive/s23.jpeg"');
		expect(html).toContain('style="--fig-w:35%"');
		expect(html).toContain('<span class="md-fig-cap">Slide 23</span>');
		expect(html).toContain("<p>Text after.</p>");
	});

	it("puts pictures written in one paragraph side by side, and keeps a picture inside a sentence in its line", () => {
		const render = renderer();
		const row = render("![a](C:/t/a.png)\n![b](C:/t/b.png)");
		expect(row).toContain('<p class="md-fig-row">');
		expect(row.match(/class="md-fig"/g)).toHaveLength(2);
		// A picture the text flows around is not part of a row.
		expect(render('![a](C:/t/a.png "left")\n![b](C:/t/b.png)')).not.toContain("md-fig-row");
		const inline = render('Press ![](C:/t/key.png "inline") to go on.');
		expect(inline).toContain('data-layout="inline"');
		expect(inline).not.toContain("md-fig-cap");
		expect(inline).toMatch(/^<p>Press <span class="md-fig"/);
	});

	it("plays video and sound, and gives sound no layout", () => {
		const html = renderer()('![demo](C:/t/demo.mp4 "center")\n\n![voice](C:/t/voice.mp3 "right")');
		expect(html).toContain('data-media-kind="video"');
		expect(html).toMatch(/data-layout="block" data-media-kind="audio"/);
	});

	it("escapes the caption and the path, keeps a web image a link, and leaves code alone", () => {
		const render = renderer();
		const html = render('![<b>"x"</b>](C:/t/a"b<c>.png)');
		expect(html).not.toContain("<b>");
		expect(html).toContain("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
		expect(html).toContain('data-media-src="C:/t/a&quot;b&lt;c&gt;.png"');
		const web = render("![logo](https://example.com/logo.png)");
		expect(web).not.toContain("md-fig");
		expect(web).not.toContain("<img");
		expect(web).toContain('<a href="https://example.com/logo.png"');
		expect(render("`![a](C:/t/a.png)`")).not.toContain("md-fig");
		expect(render("```\n![a](C:/t/a.png)\n```")).not.toContain("md-fig");
	});

	it("keeps only the caption in a read-only export copy, which has no server to load from", () => {
		const html = renderer(true)("![Slide 23](C:/t/s23.jpeg)\n![b](C:/t/b.png)");
		expect(html).not.toContain("md-fig");
		expect(html).toContain("Slide 23");
	});
});
