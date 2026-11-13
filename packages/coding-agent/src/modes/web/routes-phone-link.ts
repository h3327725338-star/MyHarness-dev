/**
 * What the Settings page uses to manage the phone link (see phone-link/gateway.ts): turn it on or off, show a QR
 * code for a new phone, list and remove paired phones. These routes are on the loopback Web UI server like every
 * other; a phone cannot reach them (they are not in the gateway's list).
 */

import { hostname } from "node:os";
import { HttpError, type WebHttpServer } from "./http-server.ts";
import type { AccountPhones } from "./phone-link/account.ts";
import { type PhoneLinkGateway, pairingUri } from "./phone-link/gateway.ts";
import { PAIRING_TTL_MS, type PhoneLinkStore } from "./phone-link/store.ts";

function asObject(body: unknown): Record<string, unknown> {
	if (typeof body !== "object" || body === null || Array.isArray(body))
		throw new HttpError(400, "Expected a JSON object");
	return body as Record<string, unknown>;
}

export function registerPhoneLinkRoutes(
	server: WebHttpServer,
	store: PhoneLinkStore,
	gateway: PhoneLinkGateway,
	account?: AccountPhones,
): void {
	const changed = () => server.broadcast("phone_link_changed", {});
	const status = () => ({ ...gateway.status(), account: account?.status() ?? null });

	server.route("GET", "/api/phone-link", () => status());

	/** Whether phones signed in with this PC's Google account may connect, from any network. */
	server.route("POST", "/api/phone-link/remote", ({ body }) => {
		try {
			store.setRemote(asObject(body).enabled === true);
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		if (!store.remote)
			for (const device of store.devices()) if (device.source === "google") gateway.disconnect(device.id);
		account?.poke();
		changed();
		return status();
	});

	server.route("POST", "/api/phone-link/enable", async ({ body }) => {
		const payload = asObject(body);
		const port = payload.port === undefined || payload.port === null ? undefined : Number(payload.port);
		try {
			store.setEnabled(payload.enabled === true, port);
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		await gateway.apply();
		account?.poke();
		changed();
		return status();
	});

	/** A new QR code. It carries a fresh key and is valid for ten minutes or until a phone uses it. */
	server.route("POST", "/api/phone-link/pair", () => {
		if (!gateway.listening) throw new HttpError(409, "Turn the phone link on first.");
		const addresses = gateway.addresses();
		if (addresses.length === 0)
			throw new HttpError(409, "This PC is not connected to a network a phone could reach.");
		let device: ReturnType<PhoneLinkStore["createPairing"]>;
		try {
			device = store.createPairing();
		} catch (error) {
			throw new HttpError(409, error instanceof Error ? error.message : String(error));
		}
		changed();
		return {
			uri: pairingUri({
				hosts: addresses,
				port: gateway.port,
				deviceId: device.id,
				key: device.key,
				name: hostname(),
			}),
			deviceId: device.id,
			expiresAt: device.createdAt + PAIRING_TTL_MS,
		};
	});

	server.route("POST", "/api/phone-link/devices/remove", ({ body }) => {
		const id = String(asObject(body).id ?? "");
		gateway.disconnect(id);
		const removed = store.remove(id);
		changed();
		return { ok: removed };
	});
}
