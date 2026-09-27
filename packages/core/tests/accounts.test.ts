import { describe, expect, it } from "vitest";
import { AccountService } from "../src/accounts.js";
import { deriveAccountKeys } from "../src/keys.js";
import { MockBackend } from "../src/mock-backend.js";
import { MemoryStateStorage, MemoryVaultStorage, StateManager } from "../src/store.js";
import { PasswordVault } from "../src/vault.js";

const SEED_HEX =
  "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04";

async function setup() {
  const backend = new MockBackend();
  const state = new StateManager(new MemoryStateStorage());
  const vault = new PasswordVault(new MemoryVaultStorage(), 1000);
  await vault.setPassword("correct horse", undefined);
  const accounts = new AccountService(backend, state, vault);
  return { backend, state, vault, accounts };
}

describe("AccountService", () => {
  it("creates accounts and registers them as summaries without key material", async () => {
    const { accounts } = await setup();
    const rec = await accounts.createAccount("public", { label: "Main" });
    expect(rec.id).toMatch(/^acc_/);
    expect(rec.type).toBe("public");
    expect(rec.hasViewingKey).toBe(false);
    expect(rec.address).toBeTruthy();

    const list = await accounts.listAccounts();
    expect(list).toHaveLength(1);
    const summary = list[0]!;
    expect(Object.keys(summary).sort()).toEqual(["address", "id", "label", "type"]);
    // no keys leak through the summary projection
    expect(JSON.stringify(summary)).not.toMatch(/secretKey|npk|vpk/);
  });

  it("keeps key material in the vault only — never in wallet state", async () => {
    const { accounts, state } = await setup();
    const rec = await accounts.createAccount("private", { label: "Priv", seedHex: SEED_HEX });
    expect(rec.hasViewingKey).toBe(true);
    expect(rec.npk).toBeTruthy();

    const rawState = JSON.stringify(await state.read());
    expect(rawState).not.toContain(SEED_HEX.slice(0, 32));
    expect(rawState).not.toMatch(/"secretKey"/);

    // derived deterministically from the seed (index 0, private)
    const derived = deriveAccountKeys(SEED_HEX, "private", 0);
    const keys = await accounts.exportKeys(rec.id);
    expect(keys.secretKey).toBe(derived.secretKey);
    expect(keys.npk).toBe(derived.npk);
    expect(keys.vpk).toBe(derived.vpk);
    expect(await accounts.getViewingKey(rec.id)).toBe(derived.vpk);
  });

  it("validates labels and flags missing accounts", async () => {
    const { accounts } = await setup();
    await expect(accounts.createAccount("public", { label: "   " })).rejects.toMatchObject({
      code: "invalid_input",
    });
    const rec = await accounts.createAccount("public", { label: "Main" });

    await accounts.setLabel(rec.id, "Renamed");
    expect((await accounts.getAccount(rec.id)).label).toBe("Renamed");
    await expect(accounts.setLabel(rec.id, " ")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(accounts.setLabel("acc_missing", "X")).rejects.toMatchObject({ code: "not_found" });
    await expect(accounts.getAccount("acc_missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(accounts.exportKeys("acc_missing")).rejects.toMatchObject({ code: "not_found" });
  });

  it("tracks the active account", async () => {
    const { accounts } = await setup();
    expect(await accounts.getActive()).toBeNull();
    const a = await accounts.createAccount("public", { label: "First" });
    const b = await accounts.createAccount("public", { label: "Second" });
    // first created account becomes active automatically
    expect((await accounts.getActive())!.id).toBe(a.id);

    await accounts.setActive(b.id);
    expect((await accounts.getActive())!.id).toBe(b.id);
    await expect(accounts.setActive("acc_missing")).rejects.toMatchObject({ code: "not_found" });
  });

  it("removes accounts and destroys their key material", async () => {
    const { accounts, vault } = await setup();
    const a = await accounts.createAccount("public", { label: "A" });
    const b = await accounts.createAccount("public", { label: "B" });
    expect((await vault.list()).sort()).toEqual([`account:${a.id}`, `account:${b.id}`].sort());

    await accounts.removeAccount(a.id);
    await expect(accounts.getAccount(a.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await vault.list()).toEqual([`account:${b.id}`]);
    await expect(accounts.exportKeys(a.id)).rejects.toMatchObject({ code: "not_found" });
    // active pointer falls back to the remaining account
    expect((await accounts.getActive())!.id).toBe(b.id);
  });

  it("imports accounts from external secret material", async () => {
    const { accounts } = await setup();
    const secretKey = "ab".repeat(32);
    const rec = await accounts.importAccount("public", { secretKey }, "Imported");
    expect(rec.label).toBe("Imported");
    expect(rec.address).toBeTruthy();
    expect((await accounts.exportKeys(rec.id)).secretKey).toBe(secretKey);
  });
});
