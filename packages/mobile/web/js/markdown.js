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

let linkHandler = null;
/** Where a tapped link goes (the built-in browser pane); set once by main.js. */
export function setLinkHandler(fn) {
	linkHandler = fn;
}

/**
 * A block of rendered Markdown. The HTML is set directly on the node and only when the text changed, so a long reply
 * being written does not go through Preact's diff for every token.
 */
export class Markdown extends Component {
	shouldComponentUpdate(next) {
		return next.text !== this.props.text || next.class !== this.props.class || next.breaks !== this.props.breaks;
	}

	componentDidMount() {
		this.paint();
	}

	componentDidUpdate() {
		this.paint();
	}

	paint() {
		const html = renderMarkdown(this.props.text || "", { breaks: this.props.breaks });
		if (this.painted !== html) {
			this.base.innerHTML = html;
			this.painted = html;
		}
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
