// Google sign-in on the phone: the same account, the same OAuth app and the same scopes as MyHarness on the PC
// (packages/coding-agent/src/sync/google.ts). Google does not allow its sign-in page inside an app's WebView, so it
// opens in the phone's browser and comes back to this app on the phone's own loopback address (MainActivity.java,
// OAuthLoopback.java), with PKCE as on the PC. The refresh token is kept by the Android Keystore (SecretStore.java),
// never in the page's storage.
//
// Scopes: openid, email and profile (whose account this is) and drive.file, which lets MyHarness see only the files
// MyHarness itself created in that Drive: the PC's MyHarness folder, nothing else of the user's.
import { t } from "/shared/i18n.js";
import { httpFetch, isNative, oauthListen, oauthStop, onNative, openExternal, secretDelete, secretGet, secretSet } from "./native.js";
import { GOOGLE_OAUTH } from "./oauth.generated.js";

export const GOOGLE_SCOPES = "openid email profile https://www.googleapis.com/auth/drive.file";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const ACCOUNT_KEY = "myharness.mobile.google";
const REFRESH_SECRET = "google.refresh";
const SIGN_IN_WAIT_MS = 10 * 60 * 1000;
const GOOGLE_TIMEOUT_MS = 30000;

let access = { token: "", expiresAt: 0 };
let refreshing = null;

const base64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomText = (length = 48) => base64Url(crypto.getRandomValues(new Uint8Array(length)));

/** The account the phone is signed in with: `{ sub, email, name }`, or null. */
export function googleAccount() {
	try {
		const saved = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "null");
		if (saved?.sub && secretGet(REFRESH_SECRET)) return saved;
	} catch {
		// Not signed in.
	}
	return null;
}

export const hasGoogleApp = () => !!GOOGLE_OAUTH.clientId;

/**
 * A request to Google with a time limit on the whole exchange, the answer's body included; it resolves with the body
 * already read. A connection that died without a word (the phone moved to another network) would otherwise keep the
 * caller waiting for minutes, and with it everything that waits for Drive: the PC list, the connection to a PC.
 */
async function fetchWithin(url, init = {}, timeoutMs = GOOGLE_TIMEOUT_MS) {
	const { signal, ...rest } = init;
	const controller = new AbortController();
	const cancel = () => controller.abort();
	if (signal?.aborted) cancel();
	signal?.addEventListener("abort", cancel, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const response = await httpFetch(url, { ...rest, signal: controller.signal });
		const body = await response.arrayBuffer();
		const empty = response.status === 204 || response.status === 205 || response.status === 304;
		return new Response(empty ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
	} catch (error) {
		if (timedOut) throw Object.assign(new Error(t("Google did not answer within {seconds} s.", { seconds: Math.round(timeoutMs / 1000) })), { code: "timeout" });
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}

async function tokenRequest(fields) {
	const body = new URLSearchParams({ client_id: GOOGLE_OAUTH.clientId, ...(GOOGLE_OAUTH.clientSecret ? { client_secret: GOOGLE_OAUTH.clientSecret } : {}), ...fields });
	const response = await fetchWithin(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) {
		const error = new Error(payload.error_description || payload.error || `Google answered HTTP ${response.status}.`);
		error.code = payload.error || "";
		error.status = response.status;
		throw error;
	}
	return payload;
}

/** Wait for the browser to come back to the loopback address with Google's answer. */
function waitForRedirect(port) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			oauthStop();
			reject(new Error(t("Sign-in took too long. Try again.")));
		}, SIGN_IN_WAIT_MS);
		const off = onNative("oauth", (event) => {
			if (event.port && event.port !== port) return;
			clearTimeout(timer);
			off();
			if (event.error) reject(new Error(event.error === "cancelled" ? t("Sign-in was cancelled.") : event.error));
			else resolve(new URLSearchParams(event.query || ""));
		});
	});
}

/** Sign in with Google in the phone's browser. Resolves with the account. */
export async function signInWithGoogle() {
	if (!hasGoogleApp()) throw new Error(t("This build of the app has no Google sign-in. Build it from the MyHarness repository."));
	if (!isNative) throw new Error(t("Google sign-in works in the phone app only."));
	const port = oauthListen();
	if (!port) throw new Error(t("The app could not wait for Google's answer. Try again."));
	const redirectUri = `http://127.0.0.1:${port}`;
	const verifier = randomText(48);
	const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	const state = randomText(16);
	const url = new URL(AUTH_URL);
	url.search = new URLSearchParams({
		client_id: GOOGLE_OAUTH.clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: GOOGLE_SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		access_type: "offline",
		prompt: "consent select_account",
	}).toString();
	const answer = waitForRedirect(port);
	openExternal(url.toString());
	const params = await answer;
	if (params.get("error")) throw new Error(params.get("error") === "access_denied" ? t("Sign-in was cancelled.") : params.get("error"));
	if (params.get("state") !== state || !params.get("code")) throw new Error(t("Google's answer did not match this sign-in. Try again."));
	const tokens = await tokenRequest({ grant_type: "authorization_code", code: params.get("code"), code_verifier: verifier, redirect_uri: redirectUri });
	if (!tokens.refresh_token) throw new Error(t("Google did not allow offline access. Try again and allow everything asked."));
	const granted = String(tokens.scope || "").split(/\s+/);
	if (!granted.includes("https://www.googleapis.com/auth/drive.file")) throw new Error(t("Google Drive access was not allowed. Sign in again and keep the Drive box ticked."));
	access = { token: tokens.access_token, expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 - 60000 };
	const info = await (await fetchWithin(USERINFO_URL, { headers: { authorization: `Bearer ${access.token}` } })).json().catch(() => ({}));
	if (!info.sub) throw new Error(t("Google did not say which account this is. Try again."));
	if (!secretSet(REFRESH_SECRET, tokens.refresh_token)) throw new Error(t("The sign-in could not be stored on this phone."));
	const account = { sub: info.sub, email: info.email || "", name: info.name || info.email || "" };
	localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
	return account;
}

/** Sign out: the refresh token is revoked at Google (when reachable) and forgotten here. */
export async function signOutOfGoogle() {
	const refresh = secretGet(REFRESH_SECRET);
	secretDelete(REFRESH_SECRET);
	localStorage.removeItem(ACCOUNT_KEY);
	access = { token: "", expiresAt: 0 };
	// In the body, not the address: addresses end up in logs.
	if (refresh) await httpFetch(REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh }).toString() }).catch(() => {});
}

/** A fresh access token for Drive. Throws `{ signedOut: true }` when Google no longer accepts the sign-in. */
export async function googleAccessToken(force = false) {
	if (!force && access.token && Date.now() < access.expiresAt) return access.token;
	refreshing ??= (async () => {
		const refresh = secretGet(REFRESH_SECRET);
		if (!refresh) throw Object.assign(new Error(t("Not signed in with Google.")), { signedOut: true });
		try {
			const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
			access = { token: tokens.access_token, expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 - 60000 };
			return access.token;
		} catch (error) {
			// The user removed MyHarness's access in their Google account, or the token expired: sign in again.
			if (error.code === "invalid_grant") {
				secretDelete(REFRESH_SECRET);
				throw Object.assign(new Error(t("Google no longer accepts this sign-in. Sign in again.")), { signedOut: true });
			}
			throw error;
		}
	})().finally(() => {
		refreshing = null;
	});
	return refreshing;
}

/**
 * `fetch` to a Google API as the signed-in account; a refused token is renewed once. `init.timeoutMs` limits the whole
 * exchange (default 30 s); the answer comes back with its body already read.
 */
export async function googleFetch(url, init = {}) {
	const { timeoutMs = GOOGLE_TIMEOUT_MS, ...rest } = init;
	for (let attempt = 0; ; attempt++) {
		const token = await googleAccessToken(attempt > 0);
		const response = await fetchWithin(url, { ...rest, headers: { ...(rest.headers || {}), authorization: `Bearer ${token}` } }, timeoutMs);
		if (response.status === 401 && attempt === 0) continue;
		return response;
	}
}
