// Markdown for replies (marked + highlight.js, the copies vendored with the desktop's HTML export). The rules are the
// desktop's (web/js/markdown.js): raw HTML is escaped and never rendered, links must be http(s)/mailto, and remote
// pictures become links because the page's Content-Security-Policy does not load them.
import { t } from "/shared/i18n.js";
import { Component, h } from "/shared/ui.js";
import { looseStrong } from "/shared/util.js";
import { copyText, haptic } from "./native.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const SAFE_LINK = /^(https?:|mailto:)/i;

export function highlight(code, language) {
	const lib = globalThis.hljs;
	try {
		if (lib && language && lib.getLanguage(language)) return lib.highlight(code, { language, ignoreIllegals: true }).value;
	} catch {
		// Plain text below.
	}
	return esc(code);
}

let engine;
function getEngine() {
	if (engine) return engine;
	const marked = globalThis.marked;
	if (!marked) return null;
	engine = new marked.Marked({ gfm: true, breaks: false, async: false });
	engine.use({
		renderer: {
			html({ text }) {
				return esc(text);
			},
			code({ text, lang }) {
				const language = (lang || "").trim().split(/\s+/)[0];
				return `<div class="code-block"><div class="code-head"><span class="code-lang">${esc(language || "text")}</span><button class="code-copy" type="button">${esc(t("Copy"))}</button></div><pre><code class="hljs">${highlight(text, language)}</code></pre></div>`;
			},
			codespan({ text }) {
				return `<code>${esc(text)}</code>`;
			},
			link({ href, title, tokens }) {
				const inner = this.parser.parseInline(tokens);
				if (!SAFE_LINK.test(href || "")) return inner;
				return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""} rel="noopener noreferrer">${inner}</a>`;
			},
			image({ href, text }) {
				return SAFE_LINK.test(href || "") ? `<a href="${esc(href)}" rel="noopener noreferrer">${esc(text || href)}</a>` : esc(text || "");
			},
			table(token) {
				const head = token.header.map((cell, i) => `<th${token.align[i] ? ` style="text-align:${token.align[i]}"` : ""}>${this.parser.parseInline(cell.tokens)}</th>`).join("");
				const body = token.rows.map((row) => `<tr>${row.map((cell, i) => `<td${token.align[i] ? ` style="text-align:${token.align[i]}"` : ""}>${this.parser.parseInline(cell.tokens)}</td>`).join("")}</tr>`).join("");
				return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
			},
		},
	});
	// Bold next to punctuation (see looseStrong in the shared util): tried before the standard emphasis rules.
	class Tokenizer extends marked.Tokenizer {
		emStrong(src, maskedSrc, prevChar) {
			const strong = looseStrong(src, prevChar);
			if (strong) return { type: "strong", raw: strong.raw, text: strong.text, tokens: this.lexer.inlineTokens(strong.text) };
			return super.emStrong(src, maskedSrc, prevChar);
		}
	}
	engine.setOptions({ tokenizer: new Tokenizer() });
	return engine;
}

const cache = new Map();
export function renderMarkdown(text, { breaks = false } = {}) {
	const key = `${breaks ? 1 : 0}\0${text}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const md = getEngine();
	let out;
	try {
		out = md ? md.parse(String(text), { breaks }) : `<pre>${esc(text)}</pre>`;
	} catch {
		out = `<pre>${esc(text)}</pre>`;
	}
	cache.set(key, out);
	if (cache.size > 200) cache.delete(cache.keys().next().value);
	return out;
}

// Where the caret of a text being written goes: at the end of the last line of text. From the last block down, for as
// long as a block holds other blocks (a list its items, a quote its paragraphs, a table its rows), to the one that holds
// the text. Null where the reply ends in something without text (a rule): no caret is drawn there.
const HOLDS_TEXT = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH", "CODE"]);
const HOLDS_BLOCKS = new Set(["UL", "OL", "LI", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "DIV"]);
const BLOCKS = new Set([...HOLDS_TEXT, ...HOLDS_BLOCKS, "PRE"]);
/** The last element in `node` that is part of the text: the caret, when it is already there, is not. */
function lastOf(node) {
	const last = node.lastElementChild;
	return last?.classList.contains("caret") ? last.previousElementSibling : last;
}
function caretHost(base) {
	let node = lastOf(base);
	// Nothing is written yet: the caret is all there is.
	if (!node) return base;
	for (;;) {
		if (HOLDS_TEXT.has(node.tagName)) return node;
		if (!HOLDS_BLOCKS.has(node.tagName)) return null;
		let inner = node.classList.contains("code-block") ? node.querySelector("pre > code") : lastOf(node);
		// A table whose body has no row yet ends in its head.
		if (!inner && node.tagName === "TBODY") inner = node.previousElementSibling;
		// A list item that ends in words (plain, bold, a link, a piece of code) holds the text itself.
		if (!inner || !BLOCKS.has(inner.tagName) || (inner.tagName === "CODE" && node.tagName !== "DIV")) return node.tagName === "LI" ? node : null;
		node = inner;
	}
}

let linkHandler = null;
/** Where a tapped link goes (the built-in browser pane); set once by main.js. */
export function setLinkHandler(fn) {
	linkHandler = fn;
}

/**
 * A block of rendered Markdown. The HTML is set directly on the node and only when the text changed, so a long reply
 * being written does not go through Preact's diff for every token.
 *
 * `caret`: the text is still being written, and a caret is drawn at the end of its last line. It is put inside the block
 * that holds that line (see caretHost) and takes no room of its own (transcript.css), so the page is exactly as tall with
 * it as without. A caret after the whole text took a line of its own under it, and the page got that line shorter in the
 * frame the writing ended: with the pane following the end, everything on screen moved down at once.
 */
export class Markdown extends Component {
	shouldComponentUpdate(next) {
		return next.text !== this.props.text || next.class !== this.props.class || next.breaks !== this.props.breaks || next.caret !== this.props.caret;
	}

	componentDidMount() {
		this.paint();
	}

	componentDidUpdate() {
		this.paint();
	}

	paint() {
		const html = renderMarkdown(this.props.text || "", { breaks: this.props.breaks });
		if (this.painted !== html) this.paintText(html);
		this.placeCaret();
	}

	paintText(html) {
		const base = this.base;
		// The caret is no part of the text: it is taken out before the blocks are compared and put back afterwards.
		this.caret?.remove();
		if (!this.painted || !base.firstChild) base.innerHTML = html;
		else {
			// The paragraphs, lists and code blocks that are already there stay as they are (their pictures do not load
			// again, a selection in them survives, nothing above the new text is laid out again): only from the first
			// block that differs on is the reply replaced.
			const next = document.createElement("template");
			next.innerHTML = html;
			const fresh = [...next.content.childNodes];
			const old = [...base.childNodes];
			let same = 0;
			while (same < old.length && same < fresh.length && old[same].isEqualNode(fresh[same])) same++;
			for (let index = old.length - 1; index >= same; index--) old[index].remove();
			for (let index = same; index < fresh.length; index++) base.appendChild(fresh[index]);
		}
		this.painted = html;
	}

	placeCaret() {
		const host = this.props.caret ? caretHost(this.base) : null;
		if (!host) {
			this.caret?.remove();
			return;
		}
		this.caret ||= Object.assign(document.createElement("span"), { className: "caret" });
		if (host.lastChild === this.caret) return;
		// A node put into the page again starts its blinking over; on one clock for all, it blinks on as it did.
		this.caret.style.animationDelay = `${-(performance.now() % 1000)}ms`;
		host.appendChild(this.caret);
	}

	onClick = (event) => {
		const copy = event.target.closest?.(".code-copy");
		if (copy) {
			const code = copy.closest(".code-block")?.querySelector("code")?.textContent || "";
			copyText(code).then((ok) => {
				if (!ok) return;
				haptic("tick");
				copy.textContent = t("Copied");
				copy.classList.add("done");
				setTimeout(() => {
					copy.textContent = t("Copy");
					copy.classList.remove("done");
				}, 1400);
			});
			return;
		}
		const link = event.target.closest?.("a[href]");
		if (link) {
			event.preventDefault();
			const href = link.getAttribute("href");
			if (/^https?:/i.test(href)) linkHandler?.(href);
			else if (/^mailto:/i.test(href)) linkHandler?.(href, { external: true });
		}
	};

	render({ class: cls }) {
		return h("div", { class: `md ${cls || ""}`, onClick: this.onClick });
	}
}
