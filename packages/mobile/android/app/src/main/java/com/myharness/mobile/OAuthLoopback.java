package com.myharness.mobile;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;

/**
 * Receives the end of a Google sign-in. Google does not show its sign-in page inside an app's WebView, so the page
 * opens in the phone's browser and Google sends that browser back to http://127.0.0.1:&lt;port&gt; on this phone, the
 * "loopback" redirect of an installed app (the same one MyHarness on the PC uses). This class listens on that address
 * for one such request, answers the browser with a short page that leads back to the app, and hands the query
 * (the code and the state the page checks) to the page. It listens on the loopback interface only, for one request,
 * for at most ten minutes.
 */
final class OAuthLoopback {
	interface Listener {
		void onQuery(int port, String query);

		void onError(int port, String message);
	}

	private static final int WAIT_MS = 10 * 60 * 1000;
	private ServerSocket server;

	/** Start listening; returns the port, or -1. A sign-in already waiting is cancelled. */
	synchronized int start(Listener listener) {
		stop();
		final ServerSocket socket;
		try {
			socket = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
			socket.setSoTimeout(WAIT_MS);
		} catch (IOException error) {
			return -1;
		}
		server = socket;
		final int port = socket.getLocalPort();
		Thread thread = new Thread(() -> {
			try {
				while (!socket.isClosed()) {
					try (Socket client = socket.accept()) {
						client.setSoTimeout(15000);
						BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
						String line = in.readLine();
						String target = "/";
						if (line != null) {
							String[] parts = line.split(" ");
							if (parts.length > 1) target = parts[1];
						}
						int mark = target.indexOf('?');
						String query = mark >= 0 ? target.substring(mark + 1) : "";
						// The browser may also ask for /favicon.ico and the like: only the redirect itself counts.
						if (!query.contains("code=") && !query.contains("error=")) {
							respond(client.getOutputStream(), "404 Not Found", "");
							continue;
						}
						respond(client.getOutputStream(), "200 OK", page(query.contains("error=")));
						listener.onQuery(port, query);
						break;
					}
				}
			} catch (SocketTimeoutException timeout) {
				listener.onError(port, "timeout");
			} catch (IOException error) {
				if (!socket.isClosed()) listener.onError(port, "The sign-in answer could not be read.");
				else listener.onError(port, "cancelled");
			} finally {
				close(socket);
			}
		}, "oauth-loopback");
		thread.setDaemon(true);
		thread.start();
		return port;
	}

	synchronized void stop() {
		if (server != null) close(server);
		server = null;
	}

	private static void close(ServerSocket socket) {
		try {
			socket.close();
		} catch (IOException ignored) {
			// Already closed.
		}
	}

	private static void respond(OutputStream out, String status, String body) throws IOException {
		byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
		String head = "HTTP/1.1 " + status + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + bytes.length
				+ "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
		out.write(head.getBytes(StandardCharsets.UTF_8));
		out.write(bytes);
		out.flush();
	}

	/** The page the browser shows: a button back to the app (an intent link), followed once by itself. */
	private static String page(boolean failed) {
		String back = "intent://signed-in#Intent;scheme=myharness;package=com.myharness.mobile;end";
		String title = failed ? "登录没有完成 · Sign-in not finished" : "已登录 · Signed in";
		String text = failed ? "回到 MyHarness 再试一次。<br>Return to MyHarness and try again."
				: "可以回到 MyHarness 了，这个页面可以关掉。<br>You can return to MyHarness and close this page.";
		return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
				+ "<title>MyHarness</title><style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;"
				+ "min-height:90vh;align-items:center;justify-content:center;text-align:center;margin:0;padding:24px}"
				+ "a{display:inline-block;margin-top:24px;padding:12px 24px;border-radius:24px;background:#3b82f6;color:#fff;"
				+ "text-decoration:none;font-weight:600}</style></head><body><div><h2>" + title + "</h2><p>" + text + "</p>"
				+ "<a href=\"" + back + "\">返回 MyHarness · Back to MyHarness</a></div>"
				+ "<script>setTimeout(function(){location.href=" + "'" + back + "'" + "},400)</script></body></html>";
	}
}
