import { describe, expect, it } from "vitest";
import { AccountService } from "../src/accounts.js";
import { MockBackend } from "../src/mock-backend.js";
import { MemoryStateStorage, MemoryVaultStorage, StateManager } from "../src/store.js";
import { TxService } from "../src/tx.js";
import { NATIVE_ASSET_ID } from "../src/types.js";
import { PasswordVault } from "../src/vault.js";

async function setup() {
  const backend = new MockBackend();
  const state = new StateManager(new MemoryStateStorage());
  const vault = new PasswordVault(new MemoryVaultStorage(), 1000);
  await vault.setPassword("correct horse", undefined);
  const accounts = new AccountService(backend, state, vault);
  const tx = new TxService(backend, state, accounts);
  const alice = await accounts.createAccount("public", { label: "Alice" });
  const bob = await accounts.createAccount("public", { label: "Bob" });
  return { backend, state, vault, accounts, tx, alice, bob };
}

describe("TxService.transfer", () => {
  it("submits a transfer and records it as pending history", async () => {
    const { backend, tx, alice, bob } = await setup();
    await backend.faucet(alice.address, NATIVE_ASSET_ID, "1000000000");

    const rec = await tx.transfer({
      fromAccountId: alice.id,
      to: { address: bob.address, type: "public" },
      amount: "250000000",
    });
    expect(rec.direction).toBe("out");
    expect(rec.status).toBe("pending");
    expect(rec.amount).toBe("250000000");
    expect(rec.assetSymbol).toBe("LOG");
    expect(rec.from).toBe(alice.address);
    expect(rec.to).toBe(bob.address);
    expect(rec.explorerUrl).toContain(rec.hash);

    const history = await tx.history();
    expect(history).toHaveLength(1);
    expect(history[0]!.hash).toBe(rec.hash);
  });

  it("validates amounts and account ids", async () => {
    const { tx, alice, bob } = await setup();
    const base = {
      fromAccountId: alice.id,
      to: { address: bob.address, type: "public" as const },
      amount: "1",
    };
    await expect(tx.transfer({ ...base, amount: "0" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(tx.transfer({ ...base, amount: "-5" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      tx.transfer({ ...base, fromAccountId: "acc_missing" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("propagates insufficient_balance from the backend", async () => {
    const { tx, alice, bob } = await setup();
    await expect(
      tx.transfer({
        fromAccountId: alice.id,
        to: { address: bob.address, type: "public" },
        amount: "1",
      }),
    ).rejects.toMatchObject({ code: "insufficient_balance" });
  });

  it("estimates gas (which may be null per LP-0021)", async () => {
    const { tx, alice, bob } = await setup();
    const est = await tx.estimateGas({
      fromAccountId: alice.id,
      to: { address: bob.address, type: "public" },
      amount: "1",
    });
    expect(est === null || typeof est.gas === "string").toBe(true);
  });
});

describe("TxService confirmation + history", () => {
  it("awaitConfirmation flips pending to confirmed with gasUsed", async () => {
    const { backend, tx, alice, bob } = await setup();
    await backend.faucet(alice.address, NATIVE_ASSET_ID, "1000");
    const rec = await tx.transfer({
      fromAccountId: alice.id,
      to: { address: bob.address, type: "public" },
      amount: "1",
    });
    expect(rec.status).toBe("pending");

    // the mock confirms on the second poll
    const done = await tx.awaitConfirmation(rec.hash, { polls: 3, intervalMs: 0 });
    expect(done.status).toBe("confirmed");
    expect(done.gasUsed).toBe("25000");
    // the updated record is what history serves
    expect((await tx.getTx(rec.hash)).status).toBe("confirmed");
  });

  it("filters history by direction and asset, newest first", async () => {
    const { backend, tx, alice, bob } = await setup();
    await backend.faucet(alice.address, NATIVE_ASSET_ID, "1000");
    await tx.transfer({
      fromAccountId: alice.id,
      to: { address: bob.address, type: "public" },
      amount: "1",
    });
    await tx.recordIncoming({
      hash: "f".repeat(64),
      fromAddress: "someone-external",
      toAccountId: bob.id,
      amount: "500",
    });

    const all = await tx.history();
    expect(all).toHaveLength(2);
    // newest first
    expect(all[0]!.hash).toBe("f".repeat(64));
    expect((await tx.history({ direction: "in" }))[0]!.direction).toBe("in");
    expect(await tx.history({ direction: "out" })).toHaveLength(1);
    expect(await tx.history({ assetId: "t".repeat(32) })).toHaveLength(0);
    expect(await tx.history({ assetId: NATIVE_ASSET_ID })).toHaveLength(2);

    const incoming = all[0]!;
    expect(incoming.status).toBe("confirmed");
    expect(incoming.from).toBe("someone-external");
    expect(incoming.to).toBe(bob.address);
  });

  it("caps history at 500 entries, dropping the oldest", async () => {
    const { tx, bob } = await setup();
    for (let i = 0; i < 505; i++) {
      await tx.recordIncoming({
        hash: i.toString(16).padStart(64, "0"),
        fromAddress: "ext",
        toAccountId: bob.id,
        amount: "1",
      });
    }
    const history = await tx.history();
    expect(history).toHaveLength(500);
    // newest first: the first five were evicted
    expect(history[0]!.hash).toBe((504).toString(16).padStart(64, "0"));
    expect(history.at(-1)!.hash).toBe((5).toString(16).padStart(64, "0"));
  });

  it("records contract calls with program metadata", async () => {
    const { tx, alice } = await setup();
    const rec = await tx.callProgram({
      fromAccountId: alice.id,
      programId: "testimonial",
      instruction: "publishTestimonial",
      args: ["hi", null, "sub-1", 0],
    });
    expect(rec.programId).toBe("testimonial");
    expect(rec.instruction).toBe("publishTestimonial");
    expect(rec.direction).toBe("out");
  });
});
