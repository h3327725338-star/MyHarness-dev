// Icons for the phone page: the desktop set (shared/icons.js) plus the few glyphs only a phone needs, drawn on the
// same 24-unit grid in the same manner (no fill, round caps and joins, the text colour).
import { h } from "/vendor/preact.js";
import { Icon as SharedIcon, strokeFor } from "/shared/icons.js";

const P = (d) => ["path", { d }];
const C = (cx, cy, r) => ["circle", { cx, cy, r }];
const R = (x, y, w, hgt, rx = 2.25) => ["rect", { x, y, width: w, height: hgt, rx }];

const EXTRA = {
	menu: [P("M4 8h16M4 16h10")],
	camera: [P("M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"), C(12, 13.5, 3.5)],
	phone: [R(7, 2.75, 10, 18.5, 2.25), P("M10.5 18.25h3")],
	qr: [R(4, 4, 6, 6, 1.25), R(14, 4, 6, 6, 1.25), R(4, 14, 6, 6, 1.25), P("M14 14h2.5v2.5H14zM20 14v.01M14 20v.01M17.5 17.5H20V20h-2.5z")],
	share: [P("M12 15V3.5M12 3.5 8 7.5M12 3.5l4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7")],
	tabs: [R(4, 7.5, 12.5, 12.5, 2.5), P("M8 4.5h9.5a2 2 0 0 1 2 2V16")],
	sun: [C(12, 12, 4), P("M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4")],
	link: [P("M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1")],
	wifi: [P("M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0M12 19.5v.01")],
	compose: [P("M12 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V12"), P("M18.4 3.6a1.9 1.9 0 0 1 2.7 2.7L12.5 15l-3.5.8.8-3.5 8.6-8.7Z")],
	type: [P("M5 6.5V5h14v1.5M12 5v14M9.5 19h5")],
	send: [P("M12 19V5.5M12 5.5 6.5 11M12 5.5l5.5 5.5")],
};

export function Icon({ name, size = 20, class: cls, style }) {
	const nodes = EXTRA[name];
	if (!nodes) return h(SharedIcon, { name, size, class: cls, style });
	return h(
		"svg",
		{ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": strokeFor(size), "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: cls, style },
		nodes.map(([tag, attrs]) => h(tag, attrs)),
	);
}

/** The MyHarness mark (favicon.svg), in the text colour. */
export function Mark({ size = 28, class: cls }) {
	return h("img", { src: "/favicon.svg", width: size, height: size, alt: "", class: cls, draggable: false });
}
