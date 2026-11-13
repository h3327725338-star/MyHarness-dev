// Runs before the first paint (a classic script in <head>): applies the saved appearance and language so the page
// never flashes the wrong theme. prefs.js owns the same keys once the modules load.
(function () {
	var prefs = {};
	try {
		prefs = JSON.parse(localStorage.getItem("myharness.mobile.prefs") || "{}") || {};
	} catch (error) {
		prefs = {};
	}
	var root = document.documentElement;
	var native = null;
	try {
		native = window.MyHarnessNative ? JSON.parse(window.MyHarnessNative.info()) : null;
	} catch (error) {
		native = null;
	}
	window.__MH_NATIVE_INFO__ = native;
	var systemDark = native ? !!native.systemDark : !window.matchMedia || window.matchMedia("(prefers-color-scheme: dark)").matches;
	var theme = prefs.theme === "dark" || prefs.theme === "light" ? prefs.theme : systemDark ? "dark" : "light";
	root.setAttribute("data-theme", theme);
	// The colour scheme of the chat mode on screen (prefs.js colorThemes and main.js say the same once they run): Coding or
	// General on the PC side, General for the phone's own assistant.
	var one = prefs.colorTheme === "forest" || prefs.colorTheme === "amber" ? prefs.colorTheme : "";
	var saved = prefs.colorThemes || {};
	var scheme = function (value, fallback) {
		return value === "classic" || value === "forest" || value === "amber" ? value : fallback;
	};
	var schemes = { coding: scheme(saved.coding || one, "classic"), general: scheme(saved.general || one, "forest") };
	var mode = "general";
	try {
		if (prefs.mode === "pc" && localStorage.getItem("myharness.mobile.link") && JSON.parse(localStorage.getItem("myharness.mobile.pc.listMode") || "null") === "coding") mode = "coding";
	} catch (error) {
		mode = "general";
	}
	root.setAttribute("data-color-theme", schemes[mode]);
	root.setAttribute("data-coding-color-theme", schemes.coding);
	root.setAttribute("data-general-color-theme", schemes.general);
	if (prefs.fontScale && prefs.fontScale !== "normal") root.setAttribute("data-font-scale", prefs.fontScale);
	if (prefs.motion === false) root.setAttribute("data-motion", "off");
	var language = prefs.lang || (native && native.language) || navigator.language || "en";
	root.lang = /^zh/i.test(language) ? "zh-CN" : "en";
	var insets = (native && native.insets) || {};
	["top", "bottom", "left", "right"].forEach(function (side) {
		root.style.setProperty("--inset-" + side, (Number(insets[side]) || 0) + "px");
	});
})();
