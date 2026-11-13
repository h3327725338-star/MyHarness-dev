package com.myharness.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.net.Uri;
import android.os.Environment;
import android.os.Message;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The built-in browser: one WebView per tab, stacked in a host view that sits above the app's own page. The page draws
 * the tab strip and the address bar and tells this class where the web content goes (`bounds`) and how far the pane is
 * slid away (`offset`); this class reports each tab's address, title and loading state back.
 *
 * These WebViews never get the app's native bridge: a web page here is as far from the app's data as it would be in
 * any browser.
 */
final class BrowserController {
	interface Host {
		void emit(String channel, JSONObject payload);

		boolean showFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params);
	}

	private final Activity activity;
	private final FrameLayout host;
	private final Host owner;
	private final float density;
	private final Map<String, WebView> tabs = new LinkedHashMap<>();
	private String activeId;
	private boolean wanted;
	private View customView;
	private WebChromeClient.CustomViewCallback customViewCallback;

	BrowserController(Activity activity, FrameLayout host, Host owner) {
		this.activity = activity;
		this.host = host;
		this.owner = owner;
		this.density = activity.getResources().getDisplayMetrics().density;
		host.setVisibility(View.GONE);
	}

	// ---- Commands from the page (always on the UI thread) ---------------------------------

	JSONObject command(JSONObject input) throws Exception {
		String action = input.optString("action");
		String id = input.optString("id", activeId == null ? "" : activeId);
		JSONObject result = new JSONObject();
		switch (action) {
			case "create": {
				WebView view = create(id);
				// A page the app reads by itself (never shown) may name the browser it is; tabs keep the web view's own.
				String agent = input.optString("userAgent", "");
				if (!agent.isEmpty()) view.getSettings().setUserAgentString(agent);
				// Such a page may also ask for a fresh copy: what it reads must not be an answer kept from last time.
				if (input.optBoolean("fresh", false)) view.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
				String url = input.optString("url", "");
				if (!url.isEmpty()) view.loadUrl(url);
				if (input.optBoolean("activate", true)) activate(id);
				break;
			}
			case "close":
				close(id);
				break;
			case "activate":
				activate(id);
				break;
			case "load": {
				WebView view = tabs.get(id);
				if (view == null) view = create(id);
				view.loadUrl(input.getString("url"));
				break;
			}
			case "back": {
				WebView view = tabs.get(id);
				if (view != null && view.canGoBack()) view.goBack();
				break;
			}
			case "forward": {
				WebView view = tabs.get(id);
				if (view != null && view.canGoForward()) view.goForward();
				break;
			}
			case "reload": {
				WebView view = tabs.get(id);
				if (view != null) view.reload();
				break;
			}
			case "stop": {
				WebView view = tabs.get(id);
				if (view != null) view.stopLoading();
				break;
			}
			case "bounds":
				setBounds(input);
				break;
			case "find": {
				WebView view = tabs.get(id);
				if (view != null) {
					String query = input.optString("query", "");
					if (query.isEmpty()) view.clearMatches();
					else if (input.optBoolean("next", false)) view.findNext(!input.optBoolean("backwards", false));
					else view.findAllAsync(query);
				}
				break;
			}
			case "desktop": {
				WebView view = tabs.get(id);
				if (view != null) {
					boolean desktop = input.optBoolean("on", false);
					WebSettings settings = view.getSettings();
					String base = WebSettings.getDefaultUserAgent(activity);
					settings.setUserAgentString(desktop ? base.replace("Mobile ", "").replaceFirst("\\(Linux; Android [^)]*\\)", "(X11; Linux x86_64)") : base);
					settings.setUseWideViewPort(true);
					settings.setLoadWithOverviewMode(true);
					view.reload();
				}
				break;
			}
			case "evaluate": {
				WebView view = tabs.get(id);
				String request = input.optString("request");
				if (view == null) {
					emitEval(request, id, null, "No such tab");
					break;
				}
				view.evaluateJavascript(input.getString("script"), (value) -> emitEval(request, id, value, null));
				break;
			}
			case "screenshot": {
				WebView view = tabs.get(id);
				String request = input.optString("request");
				JSONObject payload = new JSONObject();
				payload.put("type", "screenshot");
				payload.put("request", request);
				payload.put("id", id);
				if (view == null || view.getWidth() == 0 || view.getHeight() == 0) {
					payload.put("error", view == null ? "No such tab" : "The tab has not been shown yet");
				} else {
					int maxWidth = input.optInt("maxWidth", 720);
					float scale = Math.min(1f, maxWidth / (float) view.getWidth());
					Bitmap bitmap = Bitmap.createBitmap(Math.max(1, Math.round(view.getWidth() * scale)),
							Math.max(1, Math.round(view.getHeight() * scale)), Bitmap.Config.ARGB_8888);
					Canvas canvas = new Canvas(bitmap);
					canvas.scale(scale, scale);
					canvas.translate(-view.getScrollX(), -view.getScrollY());
					view.draw(canvas);
					ByteArrayOutputStream out = new ByteArrayOutputStream();
					bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out);
					bitmap.recycle();
					payload.put("mimeType", "image/jpeg");
					payload.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
				}
				owner.emit("browser", payload);
				break;
			}
			case "clearData": {
				CookieManager.getInstance().removeAllCookies(null);
				android.webkit.WebStorage.getInstance().deleteAllData();
				for (WebView view : tabs.values()) {
					view.clearCache(true);
					view.clearHistory();
				}
				break;
			}
			case "list":
				break;
			default:
				throw new IllegalArgumentException("Unknown browser action: " + action);
		}
		JSONArray list = new JSONArray();
		for (Map.Entry<String, WebView> entry : tabs.entrySet()) list.put(describe(entry.getKey(), entry.getValue()));
		result.put("tabs", list);
		result.put("active", activeId == null ? JSONObject.NULL : activeId);
		return result;
	}

	/** Slide the web content with the pane (page pixels from its resting place). Called for every animation frame. */
	void setOffset(float cssPx) {
		host.setTranslationX(cssPx * density);
	}

	private void setBounds(JSONObject input) {
		wanted = input.optBoolean("visible", false);
		FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) host.getLayoutParams();
		params.leftMargin = Math.round((float) input.optDouble("x", 0) * density);
		params.topMargin = Math.round((float) input.optDouble("y", 0) * density);
		params.width = Math.max(0, Math.round((float) input.optDouble("width", 0) * density));
		params.height = Math.max(0, Math.round((float) input.optDouble("height", 0) * density));
		host.setLayoutParams(params);
		if (input.has("offset")) host.setTranslationX((float) input.optDouble("offset", 0) * density);
		refreshVisibility();
	}

	private void refreshVisibility() {
		boolean show = wanted && activeId != null && tabs.containsKey(activeId);
		host.setVisibility(show ? View.VISIBLE : View.GONE);
	}

	boolean isShown() {
		return host.getVisibility() == View.VISIBLE && Math.abs(host.getTranslationX()) < 1f;
	}

	/** The system back key while the browser is on screen: one page back in the tab when it has one. */
	boolean goBack() {
		if (customView != null) {
			hideCustomView();
			return true;
		}
		WebView view = activeId == null ? null : tabs.get(activeId);
		if (view != null && view.canGoBack()) {
			view.goBack();
			return true;
		}
		return false;
	}

	void onPause() {
		for (WebView view : tabs.values()) view.onPause();
	}

	void onResume() {
		for (WebView view : tabs.values()) view.onResume();
	}

	void destroy() {
		for (WebView view : tabs.values()) {
			host.removeView(view);
			view.destroy();
		}
		tabs.clear();
	}

	// ---- Tabs ------------------------------------------------------------------------------

	@SuppressLint("SetJavaScriptEnabled")
	private WebView create(String id) {
		WebView existing = tabs.get(id);
		if (existing != null) return existing;
		WebView view = new WebView(activity);
		WebSettings settings = view.getSettings();
		settings.setJavaScriptEnabled(true);
		settings.setDomStorageEnabled(true);
		settings.setDatabaseEnabled(true);
		settings.setSupportMultipleWindows(true);
		settings.setJavaScriptCanOpenWindowsAutomatically(false);
		settings.setBuiltInZoomControls(true);
		settings.setDisplayZoomControls(false);
		settings.setUseWideViewPort(true);
		settings.setLoadWithOverviewMode(true);
		settings.setMediaPlaybackRequiresUserGesture(true);
		settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
		// Web pages get no access to the app's or the phone's files.
		settings.setAllowFileAccess(false);
		settings.setAllowContentAccess(false);
		settings.setSafeBrowsingEnabled(true);
		CookieManager.getInstance().setAcceptCookie(true);
		CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
		view.setBackgroundColor(0xFFFFFFFF);
		view.setVisibility(View.GONE);
		view.setWebViewClient(new TabClient(id));
		view.setWebChromeClient(new TabChrome(id));
		view.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
				download(id, url, userAgent, contentDisposition, mimeType));
		view.setFindListener((activeMatch, matches, done) -> {
			try {
				JSONObject payload = new JSONObject();
				payload.put("type", "find");
				payload.put("id", id);
				payload.put("active", activeMatch);
				payload.put("count", matches);
				payload.put("done", done);
				owner.emit("browser", payload);
			} catch (Exception ignored) {
				// The count is simply not shown.
			}
		});
		host.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
		tabs.put(id, view);
		return view;
	}

	private void activate(String id) {
		if (!tabs.containsKey(id)) return;
		activeId = id;
		for (Map.Entry<String, WebView> entry : tabs.entrySet()) {
			boolean active = entry.getKey().equals(id);
			entry.getValue().setVisibility(active ? View.VISIBLE : View.GONE);
		}
		refreshVisibility();
	}

	private void close(String id) {
		WebView view = tabs.remove(id);
		if (view == null) return;
		host.removeView(view);
		view.stopLoading();
		view.destroy();
		if (id.equals(activeId)) activeId = null;
		refreshVisibility();
	}

	private JSONObject describe(String id, WebView view) throws Exception {
		JSONObject tab = new JSONObject();
		tab.put("id", id);
		tab.put("url", view.getUrl() == null ? "" : view.getUrl());
		tab.put("title", view.getTitle() == null ? "" : view.getTitle());
		tab.put("canGoBack", view.canGoBack());
		tab.put("canGoForward", view.canGoForward());
		tab.put("progress", view.getProgress());
		return tab;
	}

	private void emitState(String id, String type, boolean loading) {
		WebView view = tabs.get(id);
		if (view == null) return;
		try {
			JSONObject payload = describe(id, view);
			payload.put("type", type);
			payload.put("loading", loading);
			owner.emit("browser", payload);
		} catch (Exception ignored) {
			// A tab that is going away has nothing left to report.
		}
	}

	private void emitEval(String request, String id, String value, String error) {
		try {
			JSONObject payload = new JSONObject();
			payload.put("type", "evaluate");
			payload.put("request", request);
			payload.put("id", id);
			if (error != null) payload.put("error", error);
			// evaluateJavascript hands back the JSON text of the value.
			else payload.put("value", value == null ? "null" : value);
			owner.emit("browser", payload);
		} catch (Exception ignored) {
			// Nothing more can be reported.
		}
	}

	private void download(String id, String url, String userAgent, String contentDisposition, String mimeType) {
		JSONObject payload = new JSONObject();
		try {
			payload.put("type", "download");
			payload.put("id", id);
			String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
			payload.put("name", name);
			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				payload.put("error", "unsupported");
			} else {
				DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
				request.setMimeType(mimeType);
				String cookies = CookieManager.getInstance().getCookie(url);
				if (cookies != null) request.addRequestHeader("Cookie", cookies);
				if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
				request.setTitle(name);
				request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
				request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
				((DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(request);
			}
		} catch (Exception error) {
			try {
				payload.put("error", String.valueOf(error.getMessage()));
			} catch (Exception ignored) {
				// Reported without a reason.
			}
		}
		owner.emit("browser", payload);
	}

	private void hideCustomView() {
		if (customView == null) return;
		((ViewGroup) activity.getWindow().getDecorView()).removeView(customView);
		customView = null;
		if (customViewCallback != null) customViewCallback.onCustomViewHidden();
		customViewCallback = null;
	}

	private final class TabClient extends WebViewClient {
		private final String id;

		TabClient(String id) {
			this.id = id;
		}

		@Override
		public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
			Uri uri = request.getUrl();
			String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
			if (scheme.equals("http") || scheme.equals("https") || scheme.equals("about") || scheme.equals("data") || scheme.equals("blob")) return false;
			// Links that belong to another app (mail, phone, maps, an app's own scheme) are offered to the page first:
			// the user decides whether to leave the app.
			try {
				JSONObject payload = new JSONObject();
				payload.put("type", "external");
				payload.put("id", id);
				payload.put("url", uri.toString());
				owner.emit("browser", payload);
			} catch (Exception ignored) {
				// The link is simply not followed.
			}
			return true;
		}

		@Override
		public void onPageStarted(WebView view, String url, Bitmap favicon) {
			emitState(id, "state", true);
		}

		@Override
		public void onPageFinished(WebView view, String url) {
			emitState(id, "state", false);
		}

		@Override
		public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
			emitState(id, "state", view.getProgress() < 100);
		}

		@Override
		public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
			if (!request.isForMainFrame()) return;
			try {
				JSONObject payload = describe(id, view);
				payload.put("type", "error");
				payload.put("loading", false);
				payload.put("failedUrl", request.getUrl().toString());
				payload.put("message", String.valueOf(error.getDescription()));
				owner.emit("browser", payload);
			} catch (Exception ignored) {
				// Nothing more can be reported.
			}
		}
	}

	private final class TabChrome extends WebChromeClient {
		private final String id;

		TabChrome(String id) {
			this.id = id;
		}

		@Override
		public void onProgressChanged(WebView view, int progress) {
			emitState(id, "state", progress < 100);
		}

		@Override
		public void onReceivedTitle(WebView view, String title) {
			emitState(id, "state", view.getProgress() < 100);
		}

		@Override
		public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
			// A link that wants a new window becomes a new tab; the page decides its id and tells us to create it.
			WebView.HitTestResult hit = view.getHitTestResult();
			String url = hit == null ? null : hit.getExtra();
			WebView temp = new WebView(activity);
			temp.setWebViewClient(new WebViewClient() {
				@Override
				public boolean shouldOverrideUrlLoading(WebView popup, WebResourceRequest request) {
					announceNewTab(request.getUrl().toString());
					popup.destroy();
					return true;
				}
			});
			if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
				announceNewTab(url);
				temp.destroy();
				return false;
			}
			if (!isUserGesture) {
				temp.destroy();
				return false;
			}
			((WebView.WebViewTransport) resultMsg.obj).setWebView(temp);
			resultMsg.sendToTarget();
			return true;
		}

		private void announceNewTab(String url) {
			try {
				JSONObject payload = new JSONObject();
				payload.put("type", "newTab");
				payload.put("id", id);
				payload.put("url", url);
				owner.emit("browser", payload);
			} catch (Exception ignored) {
				// The link is simply not followed.
			}
		}

		@Override
		public void onPermissionRequest(PermissionRequest request) {
			// Camera, microphone and protected media are not handed to web pages from here.
			request.deny();
		}

		@Override
		public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
			return owner.showFileChooser(callback, params);
		}

		@Override
		public void onShowCustomView(View view, CustomViewCallback callback) {
			if (customView != null) {
				callback.onCustomViewHidden();
				return;
			}
			customView = view;
			customViewCallback = callback;
			view.setBackgroundColor(0xFF000000);
			((ViewGroup) activity.getWindow().getDecorView()).addView(view,
					new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
		}

		@Override
		public void onHideCustomView() {
			hideCustomView();
		}
	}

	void openExternal(String url) {
		try {
			Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
			intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
			activity.startActivity(intent);
		} catch (Exception ignored) {
			// No app on the phone opens this address.
		}
	}
}
