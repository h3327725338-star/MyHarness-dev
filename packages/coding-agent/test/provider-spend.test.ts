import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderSpendLedger } from "../src/providers/runtime/provider-spend.ts";

describe("provider spend estimate", () => {
	it("adds up finished requests per provider, skips ones without a cost and survives a restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "myharness-spend-"));
		try {
			const file = join(dir, "provider-spend.json");
			const ledger = new ProviderSpendLedger(file);
			const usage = (total: number) => ({ usage: { cost: { total } } }) as any;
			ledger.record("first", usage(0.25));
			ledger.record("first", usage(0.5));
			ledger.record("first", usage(0));
			ledger.record("other", usage(1), "CNY");
			await ledger.flush();
			expect(ledger.get("first")).toMatchObject({ total: 0.75, requests: 2, currency: "USD" });
			const saved = JSON.parse(readFileSync(file, "utf8"));
			expect(saved.providers.other).toMatchObject({ total: 1, currency: "CNY" });
			const reopened = new ProviderSpendLedger(file);
			expect(reopened.get("first")?.total).toBe(0.75);
			reopened.reset("first");
			await reopened.flush();
			expect(new ProviderSpendLedger(file).get("first")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
