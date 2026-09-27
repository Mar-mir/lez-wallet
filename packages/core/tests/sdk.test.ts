import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../src/approval.js";
import { MockBackend } from "../src/mock-backend.js";
import { WalletSDK } from "../src/sdk.js";
import { MemoryStateStorage, MemoryVaultStorage, StateManager } from "../src/store.js";
import { NATIVE_ASSET_ID } from "../src/types.js";
import { PasswordVault } from "../src/vault.js";

async function setup(opts: { accept?: boolean } = {}) {
  const backend = new MockBackend();
  const state = new StateManager(new MemoryStateStorage());
  const vault = new PasswordVault(new MemoryVaultStorage(), 1000);
  await vault.setPassword("correct horse", undefined);
  const calls: ApprovalRequest[] = [];
  const sdk = new WalletSDK({
    backend,
    state,
    vault,
    prompt: async (req) => {
      calls.push(req);
      return opts.accept ?? true;
    },
  });
  return { backend, state, vault, sdk, calls };
}

const ORIGIN = "https://dapp.example";

describe("WalletSDK connect/disconnect", () => {
  it("grants default capabilities and scopes the dApp to the granted account", async () => {
    const { sdk, calls } = await setup();
    const acc = await sdk.createAccount("public", { label: "Main" });

    const summary = await sdk.connect({ origin: ORIGIN });
    expect(summary).toEqual({
      id: acc.id,
      type: "public",
      label: "Main",
      address: acc.address,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.capabilities).toEqual(["read_balance", "read_state", "propose_tx"]);

    const granted = await sdk.getAccounts(ORIGIN);
    expect(granted).toHaveLength(1);
    expect(granted[0]!.id).toBe(acc.id);
    const perms = await sdk.getPermissions(ORIGIN);
    expect(perms!.permissions.sort()).toEqual(["propose_tx", "read_balance", "read_state"]);

    // reconnect with the same scope does not prompt again
    await sdk.connect({ origin: ORIGIN });
    expect(calls).toHaveLength(1);

    await sdk.disconnect(ORIGIN);
    expect(await sdk.getAccounts(ORIGIN)).toEqual([]);
    expect(await sdk.getPermissions(ORIGIN)).toBeNull();
  });

  it("rejects unconnected origins with unauthorized", async () => {
    const { sdk } = await setup();
    const acc = await sdk.createAccount("public", { label: "Main" });
    await expect(sdk.getBalance(ORIGIN, acc.id, NATIVE_ASSET_ID)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(sdk.getAllBalances(ORIGIN, acc.id)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(sdk.getState(ORIGIN, acc.id, "testimonial")).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(sdk.getHistory(ORIGIN)).rejects.toMatchObject({ code: "unauthorized" });
    // with zero accounts there is nothing to connect
    const empty = await setup();
    await expect(empty.sdk.connect({ origin: ORIGIN })).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});

describe("WalletSDK balances and state", () => {
  it("serves granted reads", async () => {
    const { sdk, backend } = await setup();
    const acc = await sdk.createAccount("public", { label: "Main" });
    await backend.faucet(acc.address, NATIVE_ASSET_ID, "1234");
    await sdk.connect({ origin: ORIGIN });

    expect(await sdk.getBalance(ORIGIN, acc.id, NATIVE_ASSET_ID)).toMatchObject({
      amount: "1234",
      assetSymbol: "LOG",
    });
    const all = await sdk.getAllBalances(ORIGIN, acc.id);
    expect(all[0]!.amount).toBe("1234");
    expect(await sdk.getState(ORIGIN, acc.id, "testimonial")).toMatchObject({ data: {} });
    const est = await sdk.estimateGas(ORIGIN, {
      fromAccountId: acc.id,
      to: { address: acc.address, type: "public" },
      amount: "1",
    });
    // LP-0021: estimate MAY be null
    expect(est === null || typeof est.gas === "string").toBe(true);
    expect(await sdk.ping()).toMatchObject({ ok: true });
  });

  it("reads private balances only through the viewing key path", async () => {
    const { sdk, backend } = await setup();
    const acc = await sdk.createAccount("private", {
      label: "Priv",
      seedHex: "11".repeat(64),
    });
    await backend.faucet(acc.address, NATIVE_ASSET_ID, "77");
    await sdk.connect({ origin: ORIGIN, accountId: acc.id });
    expect(await sdk.getBalance(ORIGIN, acc.id, NATIVE_ASSET_ID)).toMatchObject({ amount: "77" });
  });
});

describe("WalletSDK send", () => {
  it("submits transfers and records history on approval", async () => {
    const { sdk, backend } = await setup();
    const alice = await sdk.createAccount("public", { label: "Alice" });
    const bob = await sdk.createAccount("public", { label: "Bob" });
    await backend.faucet(alice.address, NATIVE_ASSET_ID, "1000");
    await sdk.connect({ origin: ORIGIN, accountId: alice.id });

    const rec = await sdk.send(
      ORIGIN,
      { fromAccountId: alice.id, to: { address: bob.address, type: "public" }, amount: "400" },
      "pay bob",
    );
    expect(rec).toMatchObject({ direction: "out", status: "pending", amount: "400" });
    const history = await sdk.getHistory(ORIGIN);
    expect(history).toHaveLength(1);
    expect(history[0]!.hash).toBe(rec.hash);
  });

  it("maps per-tx rejection to rejected_by_user", async () => {
    const { sdk, backend, calls } = await setup();
    const alice = await sdk.createAccount("public", { label: "Alice" });
    const bob = await sdk.createAccount("public", { label: "Bob" });
    await backend.faucet(alice.address, NATIVE_ASSET_ID, "1000");
    await sdk.connect({ origin: ORIGIN, accountId: alice.id });

    // user vetoes just this one: flip the prompt after connect
    sdk.approvals.setPrompt(async () => false);
    await expect(
      sdk.send(ORIGIN, {
        fromAccountId: alice.id,
        to: { address: bob.address, type: "public" },
        amount: "1",
      }),
    ).rejects.toMatchObject({ code: "rejected_by_user" });
    expect(calls).toHaveLength(1); // only connect prompted (accept); send used the veto prompt
  });

  it("locks down private sends when the vault is locked (account_locked)", async () => {
    const { sdk, backend, vault } = await setup();
    const alice = await sdk.createAccount("private", { label: "Priv", seedHex: "22".repeat(64) });
    const bob = await sdk.createAccount("public", { label: "Bob" });
    await backend.faucet(alice.address, NATIVE_ASSET_ID, "1000");
    await sdk.connect({ origin: ORIGIN, accountId: alice.id });

    vault.lock();
    await expect(
      sdk.send(ORIGIN, {
        fromAccountId: alice.id,
        to: { address: bob.address, type: "public" },
        amount: "1",
      }),
    ).rejects.toMatchObject({ code: "account_locked" });
    await vault.verifyPassword("correct horse");
  });
});

describe("WalletSDK revealKeys + executeProgram", () => {
  it("revealKeys requires the explicit read_keys capability", async () => {
    const { sdk, calls } = await setup();
    const acc = await sdk.createAccount("private", { label: "Priv", seedHex: "33".repeat(64) });
    await sdk.connect({ origin: ORIGIN, accountId: acc.id });
    expect(calls).toHaveLength(1);

    // read_keys is never part of the default grant — it must prompt again
    const keys = await sdk.revealKeys(ORIGIN, acc.id);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.capabilities).toEqual(["read_keys"]);
    expect(keys.secretKey).toBeTruthy();
    expect(keys.npk).toBeTruthy();
    expect(keys.vpk).toBeTruthy();
  });

  it("revealKeys maps rejection to rejected_by_user", async () => {
    const { sdk, calls } = await setup();
    const acc = await sdk.createAccount("public", { label: "Main" });
    await sdk.connect({ origin: ORIGIN, accountId: acc.id });
    sdk.approvals.setPrompt(async () => false);
    await expect(sdk.revealKeys(ORIGIN, acc.id)).rejects.toMatchObject({
      code: "rejected_by_user",
    });
    expect(calls).toHaveLength(1);
  });

  it("executes contract calls through the propose_tx capability", async () => {
    const { sdk } = await setup();
    const acc = await sdk.createAccount("public", { label: "Main" });
    await sdk.connect({ origin: ORIGIN, accountId: acc.id });
    const rec = await sdk.executeProgram(ORIGIN, {
      fromAccountId: acc.id,
      programId: "testimonial",
      instruction: "publishTestimonial",
      args: ["hello", "alice", "sub-1", 0],
    });
    expect(rec).toMatchObject({ programId: "testimonial", instruction: "publishTestimonial" });
  });
});
