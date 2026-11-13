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
	root.setAttribute("data-color-theme", prefs.colorTheme === "forest" || prefs.colorTheme === "amber" ? prefs.colorTheme : "classic");
	if (prefs.fontScale && prefs.fontScale !== "normal") root.setAttribute("data-font-scale", prefs.fontScale);
	if (prefs.motion === false) root.setAttribute("data-motion", "off");
	var language = prefs.lang || (native && native.language) || navigator.language || "en";
	root.lang = /^zh/i.test(language) ? "zh-CN" : "en";
	var insets = (native && native.insets) || {};
	["top", "bottom", "left", "right"].forEach(function (side) {
		root.style.setProperty("--inset-" + side, (Number(insets[side]) || 0) + "px");
	});
})();
