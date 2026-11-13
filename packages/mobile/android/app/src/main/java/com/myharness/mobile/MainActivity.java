package com.myharness.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The whole app is one window: the MyHarness page (bundled with the app, served from a private https origin) and,
 * above it, the built-in browser's web content. Everything the page cannot do itself goes through {@link Bridge}.
 */
public class MainActivity extends ComponentActivity implements HttpBridge.Sink, BrowserController.Host {
	private static final String TAG = "MyHarness";
	private static final String APP_HOST = "appassets.androidplatform.net";
	private static final String APP_ORIGIN = "https://" + APP_HOST;
	private static final long MAX_SHARED_IMAGE_BYTES = 12L * 1024 * 1024;

	private PagerLayout root;
	private WebView page;
	private BrowserController browser;
	private HttpBridge http;
	private SecretStore secrets;
	private WebViewAssetLoader assets;
	private String allowedDevOrigin;
	private boolean pageReady;
	private JSONObject lastInsets = new JSONObject();
	private JSONObject pendingShare;
	/** Waits for the end of a Google sign-in on the loopback address (see OAuthLoopback). */
	private final OAuthLoopback oauth = new OAuthLoopback();
	/** Numbers the sign-ins; SignInService runs for the latest one while its listener waits. */
	private final AtomicInteger signIns = new AtomicInteger();

	private ValueCallback<Uri[]> pendingChooser;
	private WebChromeClient.FileChooserParams pendingChooserParams;
	private Uri captureUri;
	private ActivityResultLauncher<Intent> chooserLauncher;
	private ActivityResultLauncher<String> cameraPermission;
	private ActivityResultLauncher<String> notificationPermission;
	private ActivityResultLauncher<ScanOptions> scanLauncher;
	private boolean askedNotifications;

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
		getWindow().setStatusBarColor(Color.TRANSPARENT);
		getWindow().setNavigationBarColor(Color.TRANSPARENT);
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) getWindow().setNavigationBarContrastEnforced(false);
		WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
		RunService.ensureChannels(this);

		secrets = new SecretStore(this);
		http = new HttpBridge(this);

		root = new PagerLayout(this);
		root.setBackgroundColor(getColor(R.color.window_bg));
		page = new WebView(this);
		FrameLayout browserHost = new FrameLayout(this);
		root.addView(page, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
		root.addView(browserHost, new FrameLayout.LayoutParams(0, 0));
		setContentView(root);
		browser = new BrowserController(this, browserHost, this);
		root.attach(page, () -> browser.isShown(), 22 * getResources().getDisplayMetrics().density);

		registerLaunchers();
		pruneCache();
		setUpInsets();
		setUpPage();

		getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
			@Override
			public void handleOnBackPressed() {
				if (!pageReady) {
					moveTaskToBack(true);
					return;
				}
				// The page knows what is open (a sheet, the drawer, the browser pane) and closes the topmost thing.
				page.evaluateJavascript("(window.__mhBack ? window.__mhBack() : false)", (handled) -> {
					if (!"true".equals(handled)) moveTaskToBack(true);
				});
			}
		});

		handleIntent(getIntent());
	}

	// ---- The page ---------------------------------------------------------------------------

	@SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
	private void setUpPage() {
		assets = new WebViewAssetLoader.Builder()
				.setDomain(APP_HOST)
				.addPathHandler("/", new WwwHandler())
				.build();

		WebSettings settings = page.getSettings();
		settings.setJavaScriptEnabled(true);
		settings.setDomStorageEnabled(true);
		settings.setDatabaseEnabled(true);
		settings.setAllowFileAccess(false);
		settings.setAllowContentAccess(false);
		settings.setMediaPlaybackRequiresUserGesture(false);
		settings.setSupportZoom(false);
		settings.setTextZoom(Math.max(85, Math.min(135, Math.round(getResources().getConfiguration().fontScale * 100))));
		page.setOverScrollMode(View.OVER_SCROLL_NEVER);
		page.setVerticalScrollBarEnabled(false);
		page.setHorizontalScrollBarEnabled(false);
		page.setBackgroundColor(getColor(R.color.window_bg));
		page.addJavascriptInterface(new Bridge(), "MyHarnessNative");

		page.setWebViewClient(new WebViewClient() {
			@Override
			public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
				return assets.shouldInterceptRequest(request.getUrl());
			}

			@Override
			public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
				Uri uri = request.getUrl();
				String origin = uri.getScheme() + "://" + uri.getAuthority();
				if (origin.equals(APP_ORIGIN) || origin.equals(allowedDevOrigin)) return false;
				// The app's own window never leaves the app's page: any other address is handed to the page, which opens
				// it in the built-in browser.
				try {
					JSONObject payload = new JSONObject();
					payload.put("url", uri.toString());
					emit("openUrl", payload);
				} catch (Exception ignored) {
					// The link is simply not followed.
				}
				return true;
			}
		});

		page.setWebChromeClient(new WebChromeClient() {
			@Override
			public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
				return showFileChooser(callback, params);
			}

			@Override
			public void onPermissionRequest(PermissionRequest request) {
				request.deny();
			}

			@Override
			public boolean onConsoleMessage(ConsoleMessage message) {
				if (BuildConfig.DEBUG) Log.d(TAG, message.messageLevel() + " " + message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
				return true;
			}
		});

		String start = APP_ORIGIN + "/index.html";
		if (BuildConfig.DEBUG) {
			// A debug build can show the page from the developer's computer (`adb reverse` makes it localhost).
			String dev = getIntent() == null ? null : getIntent().getStringExtra("devUrl");
			if (dev != null && dev.startsWith("http://localhost:")) {
				Uri uri = Uri.parse(dev);
				allowedDevOrigin = uri.getScheme() + "://" + uri.getAuthority();
				start = dev;
			}
		}
		page.loadUrl(start);
	}

	/** Serves the bundled page: `https://appassets.androidplatform.net/<path>` is `assets/www/<path>`. */
	private final class WwwHandler implements WebViewAssetLoader.PathHandler {
		@Override
		public WebResourceResponse handle(String path) {
			String name = path.isEmpty() || path.endsWith("/") ? path + "index.html" : path;
			int query = name.indexOf('?');
			if (query >= 0) name = name.substring(0, query);
			Map<String, String> headers = new HashMap<>();
			headers.put("Cache-Control", "no-cache");
			headers.put("X-Content-Type-Options", "nosniff");
			try {
				InputStream stream = getAssets().open("www/" + name);
				return new WebResourceResponse(mimeOf(name), isText(name) ? "utf-8" : null, 200, "OK", headers, stream);
			} catch (IOException missing) {
				return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers,
						new ByteArrayInputStream("Not found".getBytes(StandardCharsets.UTF_8)));
			}
		}
	}

	private static boolean isText(String name) {
		return name.endsWith(".html") || name.endsWith(".js") || name.endsWith(".css") || name.endsWith(".json") || name.endsWith(".svg") || name.endsWith(".txt");
	}

	private static String mimeOf(String name) {
		if (name.endsWith(".html")) return "text/html";
		if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
		if (name.endsWith(".css")) return "text/css";
		if (name.endsWith(".json") || name.endsWith(".map")) return "application/json";
		if (name.endsWith(".svg")) return "image/svg+xml";
		if (name.endsWith(".png")) return "image/png";
		if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
		if (name.endsWith(".webp")) return "image/webp";
		if (name.endsWith(".woff2")) return "font/woff2";
		if (name.endsWith(".wasm")) return "application/wasm";
		return "application/octet-stream";
	}

	@Override
	public void emit(String channel, JSONObject payload) {
		final String script = "window.__mhNativeEvent&&window.__mhNativeEvent(" + JSONObject.quote(channel) + "," + payload + ")";
		runOnUiThread(() -> {
			if (page != null) page.evaluateJavascript(script, null);
		});
	}

	// ---- System bars and the keyboard -----------------------------------------------------------

	private void setUpInsets() {
		ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
			publishInsets(insets, false);
			return WindowInsetsCompat.CONSUMED;
		});
		ViewCompat.setWindowInsetsAnimationCallback(root, new WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP) {
			@Override
			public WindowInsetsCompat onProgress(WindowInsetsCompat insets, List<WindowInsetsAnimationCompat> running) {
				// The keyboard slides in over several frames: the page follows it frame by frame.
				publishInsets(insets, true);
				return insets;
			}
		});
	}

	private void publishInsets(WindowInsetsCompat insets, boolean animating) {
		float density = getResources().getDisplayMetrics().density;
		Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
		Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
		try {
			JSONObject payload = new JSONObject();
			payload.put("top", bars.top / density);
			payload.put("bottom", bars.bottom / density);
			payload.put("left", bars.left / density);
			payload.put("right", bars.right / density);
			payload.put("keyboard", Math.max(0, ime.bottom - bars.bottom) / density);
			payload.put("animating", animating);
			lastInsets = payload;
			if (pageReady) emit("insets", payload);
		} catch (Exception ignored) {
			// The page keeps the previous values.
		}
	}

	// ---- File pickers, camera, QR -------------------------------------------------------------------

	private void registerLaunchers() {
		chooserLauncher = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), (result) -> {
			ValueCallback<Uri[]> callback = pendingChooser;
			pendingChooser = null;
			pendingChooserParams = null;
			if (callback == null) return;
			Uri[] picked = null;
			if (result.getResultCode() == RESULT_OK) {
				Intent data = result.getData();
				if (captureUri != null && (data == null || data.getData() == null)) {
					picked = new Uri[]{captureUri};
				} else if (data != null && data.getClipData() != null) {
					ClipData clip = data.getClipData();
					picked = new Uri[clip.getItemCount()];
					for (int i = 0; i < clip.getItemCount(); i++) picked[i] = clip.getItemAt(i).getUri();
				} else if (data != null && data.getData() != null) {
					picked = new Uri[]{data.getData()};
				}
			}
			boolean captured = captureUri != null;
			captureUri = null;
			if (picked == null || captured) {
				callback.onReceiveValue(picked);
				return;
			}
			// What a picker hands over is an address into another app (Photos, Drive, a file manager). The page may
			// read it more than once and much later (when the message is sent), and such addresses can change under
			// it or stop answering; the page then fails with "file changed". So each picked file is copied into this
			// app's cache first and the page gets the copy.
			final Uri[] chosen = picked;
			new Thread(() -> {
				Uri[] stable = stableCopies(chosen);
				runOnUiThread(() -> callback.onReceiveValue(stable));
			}, "picked-files").start();
		});
		cameraPermission = registerForActivityResult(new ActivityResultContracts.RequestPermission(), (granted) -> {
			if (granted && pendingChooser != null) launchCamera();
			else cancelChooser();
		});
		notificationPermission = registerForActivityResult(new ActivityResultContracts.RequestPermission(), (granted) -> {
		});
		scanLauncher = registerForActivityResult(new ScanContract(), (result) -> {
			try {
				JSONObject payload = new JSONObject();
				payload.put("text", result.getContents() == null ? JSONObject.NULL : result.getContents());
				emit("scan", payload);
			} catch (Exception ignored) {
				// The page sees no result and lets the user try again.
			}
		});
	}

	/** Picked files up to this size are copied; a larger one is handed over as it is (the page refuses it by its size). */
	private static final long MAX_PICK_COPY_BYTES = 64L * 1024 * 1024;

	private Uri[] stableCopies(Uri[] uris) {
		File base = new File(new File(getCacheDir(), "picked"), String.valueOf(System.currentTimeMillis()));
		Uri[] out = new Uri[uris.length];
		for (int i = 0; i < uris.length; i++) {
			out[i] = uris[i];
			if (uris[i] == null || !"content".equals(uris[i].getScheme())) continue;
			try {
				String name = null;
				long size = -1;
				try (Cursor cursor = getContentResolver().query(uris[i], new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
					if (cursor != null && cursor.moveToFirst()) {
						name = cursor.getString(0);
						if (!cursor.isNull(1)) size = cursor.getLong(1);
					}
				}
				if (size > MAX_PICK_COPY_BYTES) continue;
				if (name == null || name.trim().isEmpty()) name = "file-" + (i + 1);
				name = name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_");
				File dir = new File(base, String.valueOf(i));
				if (!dir.mkdirs()) continue;
				File copy = new File(dir, name);
				boolean complete = true;
				try (InputStream in = getContentResolver().openInputStream(uris[i]); OutputStream target = new FileOutputStream(copy)) {
					if (in == null) continue;
					byte[] buffer = new byte[64 * 1024];
					long total = 0;
					int count;
					while ((count = in.read(buffer)) > 0) {
						total += count;
						if (total > MAX_PICK_COPY_BYTES) {
							complete = false;
							break;
						}
						target.write(buffer, 0, count);
					}
				}
				if (complete) out[i] = Uri.fromFile(copy);
				else copy.delete();
			} catch (Exception ignored) {
				// The page gets the picker's own address and reads it as far as it can.
			}
		}
		return out;
	}

	/** Copies of picked files and camera photos are needed only until their message is sent: a day is plenty. */
	private void pruneCache() {
		new Thread(() -> {
			long cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
			for (String name : new String[]{"picked", "captures"}) {
				File[] entries = new File(getCacheDir(), name).listFiles();
				if (entries == null) continue;
				for (File entry : entries) if (entry.lastModified() < cutoff) deleteTree(entry);
			}
		}, "prune-cache").start();
	}

	private static void deleteTree(File file) {
		File[] children = file.listFiles();
		if (children != null) for (File child : children) deleteTree(child);
		file.delete();
	}

	private void cancelChooser() {
		if (pendingChooser != null) pendingChooser.onReceiveValue(null);
		pendingChooser = null;
		pendingChooserParams = null;
		captureUri = null;
	}

	@Override
	public boolean showFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
		cancelChooser();
		pendingChooser = callback;
		pendingChooserParams = params;
		try {
			if (params.isCaptureEnabled()) {
				if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchCamera();
				else cameraPermission.launch(Manifest.permission.CAMERA);
				return true;
			}
			Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
			intent.addCategory(Intent.CATEGORY_OPENABLE);
			String[] types = params.getAcceptTypes();
			java.util.ArrayList<String> mimes = new java.util.ArrayList<>();
			if (types != null) {
				for (String type : types) {
					if (type == null || type.isEmpty()) continue;
					if (type.startsWith(".")) {
						String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(type.substring(1));
						if (mime != null) mimes.add(mime);
					} else mimes.add(type);
				}
			}
			if (mimes.size() == 1) intent.setType(mimes.get(0));
			else {
				intent.setType("*/*");
				if (mimes.size() > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
			}
			intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
			chooserLauncher.launch(Intent.createChooser(intent, null));
			return true;
		} catch (Exception error) {
			cancelChooser();
			return false;
		}
	}

	private void launchCamera() {
		try {
			File dir = new File(getCacheDir(), "captures");
			if (!dir.exists() && !dir.mkdirs()) throw new IOException("No room for the photo");
			File photo = new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
			captureUri = FileProvider.getUriForFile(this, getPackageName() + ".files", photo);
			Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
			intent.putExtra(MediaStore.EXTRA_OUTPUT, captureUri);
			intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
			chooserLauncher.launch(intent);
		} catch (Exception error) {
			cancelChooser();
		}
	}

	// ---- Things other apps hand to this one --------------------------------------------------------

	@Override
	protected void onNewIntent(Intent intent) {
		super.onNewIntent(intent);
		setIntent(intent);
		handleIntent(intent);
	}

	private void handleIntent(Intent intent) {
		if (intent == null || intent.getAction() == null) return;
		try {
			JSONObject payload = new JSONObject();
			// The page Google sign-in ends on leads back here: being in front again is all it asks for.
			if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null && "myharness".equals(intent.getData().getScheme())
					&& "signed-in".equals(intent.getData().getHost())) return;
			if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null && "myharness".equals(intent.getData().getScheme())) {
				payload.put("link", intent.getData().toString());
			} else if (Intent.ACTION_SEND.equals(intent.getAction())) {
				String text = intent.getStringExtra(Intent.EXTRA_TEXT);
				if (text != null) payload.put("text", text);
				Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
				if (stream != null) {
					JSONObject image = readShared(stream, intent.getType());
					if (image != null) payload.put("images", new JSONArray().put(image));
				}
			}
			if (payload.length() == 0) return;
			pendingShare = payload;
			if (pageReady) deliverShare();
		} catch (Exception ignored) {
			// Something that cannot be read is not delivered.
		}
	}

	private JSONObject readShared(Uri uri, String type) {
		try (InputStream in = getContentResolver().openInputStream(uri)) {
			if (in == null) return null;
			ByteArrayOutputStream out = new ByteArrayOutputStream();
			byte[] buffer = new byte[64 * 1024];
			int read;
			while ((read = in.read(buffer)) != -1) {
				out.write(buffer, 0, read);
				if (out.size() > MAX_SHARED_IMAGE_BYTES) return null;
			}
			String mime = getContentResolver().getType(uri);
			JSONObject image = new JSONObject();
			image.put("mimeType", mime != null ? mime : (type != null && !type.endsWith("/*") ? type : "image/jpeg"));
			image.put("name", uri.getLastPathSegment() == null ? "shared" : uri.getLastPathSegment());
			image.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
			return image;
		} catch (Exception error) {
			return null;
		}
	}

	private void deliverShare() {
		if (pendingShare == null) return;
		JSONObject payload = pendingShare;
		pendingShare = null;
		emit("share", payload);
	}

	// ---- Lifecycle --------------------------------------------------------------------------------

	@Override
	protected void onPause() {
		super.onPause();
		browser.onPause();
		emitSimple("lifecycle", "state", "background");
	}

	@Override
	protected void onResume() {
		super.onResume();
		browser.onResume();
		emitSimple("lifecycle", "state", "foreground");
	}

	@Override
	public void onConfigurationChanged(Configuration newConfig) {
		super.onConfigurationChanged(newConfig);
		emitSimple("lifecycle", "systemDark", (newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
	}

	@Override
	protected void onDestroy() {
		oauth.stop();
		SignInService.stop(this);
		http.abortAll();
		RunService.stop(this);
		browser.destroy();
		root.removeView(page);
		page.destroy();
		page = null;
		super.onDestroy();
	}

	/** A sign-in's listener is done (answered, failed, timed out or cancelled): the app need not stay awake for it. */
	private void signInEnded(int signIn) {
		// A listener replaced by a newer sign-in ends after the new one started: that must not stop the service.
		if (signIn != signIns.get()) return;
		SignInService.stop(this);
	}

	private void emitSimple(String channel, String key, Object value) {
		if (!pageReady) return;
		try {
			JSONObject payload = new JSONObject();
			payload.put(key, value);
			emit(channel, payload);
		} catch (Exception ignored) {
			// Not reported.
		}
	}

	// ---- What the page may ask for ---------------------------------------------------------------

	/** Called from the page (on WebView's own bridge thread). Only the app's page has this object. */
	private final class Bridge {
		@JavascriptInterface
		public String info() {
			try {
				JSONObject info = new JSONObject();
				info.put("version", BuildConfig.VERSION_NAME);
				info.put("versionCode", BuildConfig.VERSION_CODE);
				info.put("debug", BuildConfig.DEBUG);
				info.put("sdk", Build.VERSION.SDK_INT);
				info.put("android", Build.VERSION.RELEASE);
				info.put("device", (Build.MANUFACTURER + " " + Build.MODEL).trim());
				info.put("language", getResources().getConfiguration().getLocales().get(0).toLanguageTag());
				info.put("systemDark", (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
				info.put("insets", lastInsets);
				return info.toString();
			} catch (Exception error) {
				return "{}";
			}
		}

		/** The page has started: from now on it receives events, beginning with what happened before it could listen. */
		@JavascriptInterface
		public void ready() {
			runOnUiThread(() -> {
				pageReady = true;
				emit("insets", lastInsets);
				deliverShare();
			});
		}

		@JavascriptInterface
		public void httpStart(String id, String method, String url, String headersJson, String bodyText, String bodyBase64) {
			http.start(id, method, url, headersJson, bodyText, bodyBase64);
		}

		@JavascriptInterface
		public void httpAbort(String id) {
			http.abort(id);
		}

		@JavascriptInterface
		public String secretGet(String name) {
			return secrets.get(name);
		}

		@JavascriptInterface
		public boolean secretSet(String name, String value) {
			return secrets.set(name, value);
		}

		@JavascriptInterface
		public void secretDelete(String name) {
			secrets.delete(name);
		}

		/** One browser command; its answer comes back as a `browser` event of type `result` with the same `request`. */
		@JavascriptInterface
		public void browser(String json) {
			runOnUiThread(() -> {
				JSONObject answer = new JSONObject();
				String request = "";
				try {
					JSONObject input = new JSONObject(json);
					request = input.optString("request", "");
					answer = browser.command(input);
				} catch (Exception error) {
					try {
						answer.put("error", String.valueOf(error.getMessage()));
					} catch (Exception ignored) {
						// Reported without a reason.
					}
				}
				try {
					answer.put("type", "result");
					answer.put("request", request);
				} catch (Exception ignored) {
					// Reported as it is.
				}
				emit("browser", answer);
			});
		}

		@JavascriptInterface
		public void browserOffset(float cssPx) {
			runOnUiThread(() -> browser.setOffset(cssPx));
		}

		@JavascriptInterface
		public boolean browserBack() {
			final boolean[] handled = {false};
			final Object lock = new Object();
			synchronized (lock) {
				runOnUiThread(() -> {
					synchronized (lock) {
						handled[0] = browser.goBack();
						lock.notifyAll();
					}
				});
				try {
					lock.wait(500);
				} catch (InterruptedException ignored) {
					Thread.currentThread().interrupt();
				}
			}
			return handled[0];
		}

		/** Light or dark icons in the status and navigation bars, and the colour behind the page while it loads. */
		@JavascriptInterface
		public void setChrome(String json) {
			runOnUiThread(() -> {
				try {
					JSONObject input = new JSONObject(json);
					boolean dark = input.optBoolean("dark", true);
					WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), root);
					controller.setAppearanceLightStatusBars(!dark);
					controller.setAppearanceLightNavigationBars(!dark);
					String background = input.optString("background", "");
					if (!background.isEmpty()) {
						int color = Color.parseColor(background);
						root.setBackgroundColor(color);
						page.setBackgroundColor(color);
					}
				} catch (Exception ignored) {
					// The bars keep their look.
				}
			});
		}

		@JavascriptInterface
		public void haptic(String kind) {
			runOnUiThread(() -> {
				int feedback = HapticFeedbackConstants.CLOCK_TICK;
				if ("press".equals(kind)) feedback = HapticFeedbackConstants.KEYBOARD_TAP;
				else if ("long".equals(kind)) feedback = HapticFeedbackConstants.LONG_PRESS;
				else if ("confirm".equals(kind) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) feedback = HapticFeedbackConstants.CONFIRM;
				else if ("reject".equals(kind) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) feedback = HapticFeedbackConstants.REJECT;
				root.performHapticFeedback(feedback);
			});
		}

		@JavascriptInterface
		public void copy(String text) {
			runOnUiThread(() -> {
				ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
				if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("MyHarness", text));
			});
		}

		@JavascriptInterface
		public void share(String text) {
			runOnUiThread(() -> {
				Intent send = new Intent(Intent.ACTION_SEND);
				send.setType("text/plain");
				send.putExtra(Intent.EXTRA_TEXT, text);
				startActivity(Intent.createChooser(send, null));
			});
		}

		@JavascriptInterface
		public void openExternal(String url) {
			runOnUiThread(() -> browser.openExternal(url));
		}

		/** Start waiting for a Google sign-in to come back (google.js); the answer is an "oauth" event. */
		@JavascriptInterface
		public int oauthListen() {
			final int signIn = signIns.incrementAndGet();
			int started = oauth.start(new OAuthLoopback.Listener() {
				@Override
				public void onQuery(int port, String query) {
					signInEnded(signIn);
					runOnUiThread(() -> {
						try {
							JSONObject payload = new JSONObject();
							payload.put("port", port);
							payload.put("query", query);
							emit("oauth", payload);
						} catch (Exception ignored) {
							// Not reported.
						}
					});
				}

				@Override
				public void onError(int port, String message) {
					signInEnded(signIn);
					runOnUiThread(() -> {
						try {
							JSONObject payload = new JSONObject();
							payload.put("port", port);
							payload.put("error", message);
							emit("oauth", payload);
						} catch (Exception ignored) {
							// Not reported.
						}
					});
				}
			});
			// The browser comes to the front now and this app goes to the background, where Android would freeze it
			// before Google sends the browser back to the listener (see SignInService).
			if (started > 0) SignInService.start(MainActivity.this);
			else signInEnded(signIn);
			return started;
		}

		@JavascriptInterface
		public void oauthStop() {
			oauth.stop();
			signInEnded(signIns.get());
		}

		@JavascriptInterface
		public void scanQr() {
			runOnUiThread(() -> {
				ScanOptions options = new ScanOptions();
				options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
				options.setPrompt(getString(R.string.scan_prompt));
				options.setBeepEnabled(false);
				options.setOrientationLocked(true);
				scanLauncher.launch(options);
			});
		}

		/** Save bytes the page made (an exported chat, a picture from a reply) into the phone's Downloads folder. */
		@JavascriptInterface
		public String saveFile(String name, String mimeType, String base64) {
			try {
				byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
				String safe = name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_");
				if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
					ContentValues values = new ContentValues();
					values.put(MediaStore.Downloads.DISPLAY_NAME, safe);
					values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
					values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/MyHarness");
					Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
					if (uri == null) return "";
					try (OutputStream out = getContentResolver().openOutputStream(uri)) {
						if (out == null) return "";
						out.write(bytes);
					}
					return "Download/MyHarness/" + safe;
				}
				File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
				if (dir == null) return "";
				File file = new File(dir, safe);
				try (OutputStream out = new java.io.FileOutputStream(file)) {
					out.write(bytes);
				}
				return file.getAbsolutePath();
			} catch (Exception error) {
				return "";
			}
		}

		/** A reply is being generated (or no longer is): keep the app alive meanwhile. */
		@JavascriptInterface
		public void runActive(boolean active, String title) {
			runOnUiThread(() -> {
				if (active) {
					if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !askedNotifications
							&& checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
						askedNotifications = true;
						notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS);
					}
					RunService.start(MainActivity.this, title);
				} else RunService.stop(MainActivity.this);
			});
		}

		/** A reply finished while the app was not on screen. */
		@JavascriptInterface
		public void notifyDone(String title, String text) {
			runOnUiThread(() -> {
				NotificationManager manager = getSystemService(NotificationManager.class);
				if (manager == null || !manager.areNotificationsEnabled()) return;
				Notification notification = new Notification.Builder(MainActivity.this, RunService.DONE_CHANNEL)
						.setSmallIcon(R.drawable.ic_stat_run)
						.setContentTitle(title)
						.setContentText(text)
						.setAutoCancel(true)
						.setContentIntent(RunService.openApp(MainActivity.this))
						.build();
				manager.notify(2, notification);
			});
		}

		@JavascriptInterface
		public void leave() {
			runOnUiThread(() -> moveTaskToBack(true));
		}
	}
}
