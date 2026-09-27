import { describe, expect, it } from "vitest";
import { MemoryVaultStorage } from "../src/store.js";
import { PasswordVault } from "../src/vault.js";

const fast = () => new PasswordVault(new MemoryVaultStorage(), 1000);

describe("PasswordVault", () => {
  it("initializes with a password and rejects weak passwords", async () => {
    const vault = fast();
    expect(await vault.isInitialized()).toBe(false);
    await expect(vault.setPassword("short", undefined)).rejects.toMatchObject({ code: "invalid_input" });
    await vault.setPassword("correct horse", undefined);
    expect(await vault.isInitialized()).toBe(true);
    expect(vault.isUnlocked()).toBe(true);
  });

  it("rejects wrong passwords with password_invalid and never wipes data", async () => {
    const vault = fast();
    await vault.setPassword("correct horse", undefined);
    await vault.put("key1", { a: 1 });

    await expect(vault.verifyPassword("wrong")).rejects.toMatchObject({ code: "password_invalid" });
    expect(vault.isUnlocked()).toBe(false);
    // data still there after a failed attempt
    await vault.verifyPassword("correct horse");
    expect(await vault.get("key1")).toEqual({ a: 1 });
  });

  it("encrypts secrets at rest and requires unlock to read them", async () => {
    const storage = new MemoryVaultStorage();
    const vault = new PasswordVault(storage, 1000);
    await vault.setPassword("correct horse", undefined);
    await vault.put("key1", { a: 1 });

    // raw storage never holds plaintext
    const raw = JSON.stringify(await storage.read());
    expect(raw).not.toContain('"a":1');

    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    await expect(vault.get("key1")).rejects.toMatchObject({ code: "account_locked" });
    await expect(vault.put("key1", { a: 2 })).rejects.toMatchObject({ code: "account_locked" });

    // a re-opened vault starts locked and needs the password
    const reopened = new PasswordVault(storage, 1000);
    expect(reopened.isUnlocked()).toBe(false);
    await reopened.verifyPassword("correct horse");
    expect(await reopened.get("key1")).toEqual({ a: 1 });
  });

  it("throws not_found for missing secrets and delete is idempotent", async () => {
    const vault = fast();
    await vault.setPassword("correct horse", undefined);
    await vault.put("key1", { a: 1 });
    expect((await vault.list()).sort()).toEqual(["key1"]);

    await vault.delete("key1");
    await expect(vault.get("key1")).rejects.toMatchObject({ code: "not_found" });
    await vault.delete("key1"); // no throw
  });

  it("changes the password by re-encrypting; the old password stops working", async () => {
    const vault = fast();
    await vault.setPassword("correct horse", undefined);
    await vault.put("key1", { a: 1 });

    // changing requires the current password
    await expect(vault.setPassword("new passphrase", undefined)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await vault.setPassword("new passphrase", "correct horse");

    expect(await vault.get("key1")).toEqual({ a: 1 });
    await expect(vault.verifyPassword("correct horse")).rejects.toMatchObject({
      code: "password_invalid",
    });
    await vault.verifyPassword("new passphrase");
    expect(await vault.get("key1")).toEqual({ a: 1 });
  });
});
