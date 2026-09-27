import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyState,
  FileStateStore,
  MemoryStateStorage,
  StateManager,
} from "../src/store.js";

describe("emptyState", () => {
  it("has the expected shape and safe defaults", () => {
    const s = emptyState();
    expect(s.version).toBe(1);
    expect(s.passwordSet).toBe(false);
    expect(s.mnemonicConfirmed).toBe(false);
    expect(s.accounts).toEqual({});
    expect(s.activeAccountId).toBeNull();
    expect(s.txHistory).toEqual([]);
    expect(s.approvals).toEqual({});
    expect(s.settings.autoLockMinutes).toBe(10);
    expect(s.settings.priceApiEnabled).toBe(false);
  });
});

describe("MemoryStateStorage", () => {
  it("round-trips state defensively (deep copy)", async () => {
    const store = new MemoryStateStorage();
    expect(await store.read()).toBeNull();
    const s = emptyState();
    s.passwordSet = true;
    await store.writeAtomic(s);
    const back = await store.read();
    expect(back!.passwordSet).toBe(true);
    // the stored copy is detached from the caller's object
    s.passwordSet = false;
    expect((await store.read())!.passwordSet).toBe(true);
  });
});

describe("FileStateStore", () => {
  it("persists state atomically and reads it back", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lez-store-"));
    const file = path.join(dir, "wallet-state.json");
    const store = new FileStateStore(file);
    expect(await store.read()).toBeNull();

    const s = emptyState();
    s.mnemonicConfirmed = true;
    await store.writeAtomic(s);

    const fresh = new FileStateStore(file); // new instance: no cache
    const back = await fresh.read();
    expect(back!.mnemonicConfirmed).toBe(true);

    // no temp files left behind
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(["wallet-state.json"]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("throws io_error on corrupt state files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lez-store-"));
    const file = path.join(dir, "wallet-state.json");
    await fs.writeFile(file, "{ not json", "utf8");
    const store = new FileStateStore(file);
    await expect(store.read()).rejects.toMatchObject({ code: "io_error" });
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("StateManager", () => {
  it("serves emptyState when storage is empty", async () => {
    const sm = new StateManager(new MemoryStateStorage());
    expect((await sm.read()).version).toBe(1);
    expect((await sm.read()).accounts).toEqual({});
  });

  it("serializes concurrent updates — none are lost", async () => {
    const sm = new StateManager(new MemoryStateStorage());
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        sm.update((s) => {
          s.accounts[`acc_${i}`] = {
            id: `acc_${i}`,
            type: "public",
            label: `Account ${i}`,
            address: `addr-${i}`,
            hasViewingKey: false,
            createdAt: new Date().toISOString(),
          };
        }),
      ),
    );
    const s = await sm.read();
    expect(Object.keys(s.accounts)).toHaveLength(N);
  });

  it("update() returns the callback result and propagates errors without corrupting state", async () => {
    const sm = new StateManager(new MemoryStateStorage());
    const result = await sm.update((s) => {
      s.passwordSet = true;
      return 42;
    });
    expect(result).toBe(42);

    await expect(
      sm.update(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // the failed update did not clobber the persisted state
    expect((await sm.read()).passwordSet).toBe(true);
  });
});
