package com.myharness.mobile;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.Iterator;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.BufferedSource;

/**
 * The page's network channel. A page inside a WebView can only reach servers that allow its origin, which model
 * providers, search engines and the PC link do not; requests made here go out as the app's own and their answers are
 * streamed back to the page as they arrive (model replies and the PC's event stream are both long-lived streams).
 */
final class HttpBridge {
	interface Sink {
		void emit(String channel, JSONObject payload);
	}

	private static final int CHUNK_BYTES = 16 * 1024;
	private final OkHttpClient client;
	private final ConcurrentHashMap<String, Call> calls = new ConcurrentHashMap<>();
	private final Sink sink;

	HttpBridge(Sink sink) {
		this.sink = sink;
		this.client = new OkHttpClient.Builder()
				.connectTimeout(20, TimeUnit.SECONDS)
				.writeTimeout(120, TimeUnit.SECONDS)
				// A streamed reply may think for minutes between two bytes; the page decides when to give up.
				.readTimeout(0, TimeUnit.SECONDS)
				// A connection kept for the next request can die silently, for example when the phone moves from one
				// network to another; without pings a request sent on it would wait for minutes. A ping without an
				// answer ends the connection (HTTP/2, which Google's APIs use) and the next request opens a new one.
				.pingInterval(5, TimeUnit.SECONDS)
				.followRedirects(true)
				.followSslRedirects(true)
				.build();
	}

	void start(String id, String method, String url, String headersJson, String bodyText, String bodyBase64) {
		Call call;
		try {
			Request.Builder builder = new Request.Builder().url(url);
			String contentType = null;
			if (headersJson != null && !headersJson.isEmpty()) {
				JSONObject headers = new JSONObject(headersJson);
				for (Iterator<String> names = headers.keys(); names.hasNext(); ) {
					String name = names.next();
					String value = headers.optString(name, "");
					if ("content-type".equalsIgnoreCase(name)) contentType = value;
					// The connection's own headers are OkHttp's to set.
					if ("host".equalsIgnoreCase(name) || "content-length".equalsIgnoreCase(name)
							|| "connection".equalsIgnoreCase(name) || "accept-encoding".equalsIgnoreCase(name)) continue;
					try {
						builder.header(name, value);
					} catch (IllegalArgumentException invalid) {
						builder.header(name, sanitize(value));
					}
				}
			}
			String verb = method == null || method.isEmpty() ? "GET" : method.toUpperCase();
			RequestBody body = null;
			MediaType type = contentType == null ? null : MediaType.parse(contentType);
			if (bodyBase64 != null) body = RequestBody.create(Base64.decode(bodyBase64, Base64.DEFAULT), type);
			else if (bodyText != null) body = RequestBody.create(bodyText.getBytes(java.nio.charset.StandardCharsets.UTF_8), type);
			else if (!"GET".equals(verb) && !"HEAD".equals(verb)) body = RequestBody.create(new byte[0], type);
			builder.method(verb, "GET".equals(verb) || "HEAD".equals(verb) ? null : body);
			call = client.newCall(builder.build());
		} catch (Exception error) {
			fail(id, error);
			return;
		}
		calls.put(id, call);
		call.enqueue(new Callback() {
			@Override
			public void onFailure(Call failed, IOException error) {
				calls.remove(id);
				fail(id, error);
			}

			@Override
			public void onResponse(Call answered, Response response) {
				try (ResponseBody responseBody = response.body()) {
					JSONObject head = new JSONObject();
					head.put("id", id);
					head.put("type", "head");
					head.put("status", response.code());
					head.put("statusText", response.message());
					head.put("url", response.request().url().toString());
					JSONArray headerList = new JSONArray();
					Headers headers = response.headers();
					for (int i = 0; i < headers.size(); i++) {
						String name = headers.name(i);
						// OkHttp already decoded the body: the page must not try to decode it again.
						if ("content-encoding".equalsIgnoreCase(name) || "content-length".equalsIgnoreCase(name)) continue;
						headerList.put(new JSONArray().put(name).put(headers.value(i)));
					}
					head.put("headers", headerList);
					sink.emit("http", head);

					BufferedSource source = responseBody.source();
					Buffer buffer = new Buffer();
					while (!answered.isCanceled()) {
						long read = source.read(buffer, CHUNK_BYTES);
						if (read == -1) break;
						// Hand over everything that has arrived so far in one piece.
						while (source.getBuffer().size() > 0 && buffer.size() < 256 * 1024) {
							long more = source.read(buffer, CHUNK_BYTES);
							if (more == -1) break;
						}
						JSONObject chunk = new JSONObject();
						chunk.put("id", id);
						chunk.put("type", "chunk");
						chunk.put("data", Base64.encodeToString(buffer.readByteArray(), Base64.NO_WRAP));
						sink.emit("http", chunk);
					}
					JSONObject end = new JSONObject();
					end.put("id", id);
					end.put("type", "end");
					sink.emit("http", end);
				} catch (Exception error) {
					fail(id, error);
				} finally {
					calls.remove(id);
				}
			}
		});
	}

	void abort(String id) {
		Call call = calls.remove(id);
		if (call != null) call.cancel();
	}

	void abortAll() {
		for (Call call : calls.values()) call.cancel();
		calls.clear();
	}

	private void fail(String id, Exception error) {
		try {
			JSONObject payload = new JSONObject();
			payload.put("id", id);
			payload.put("type", "error");
			String message = error.getMessage();
			payload.put("message", message == null || message.isEmpty() ? error.getClass().getSimpleName() : message);
			payload.put("kind", error.getClass().getSimpleName());
			sink.emit("http", payload);
		} catch (Exception ignored) {
			// Nothing more can be reported.
		}
	}

	private static String sanitize(String value) {
		StringBuilder out = new StringBuilder(value.length());
		for (int i = 0; i < value.length(); i++) {
			char c = value.charAt(i);
			if (c == '\t' || (c >= 0x20 && c < 0x7f)) out.append(c);
		}
		return out.toString();
	}
}
