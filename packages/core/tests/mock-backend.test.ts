import { describe, expect, it } from "vitest";
import { MockBackend, emptyMockChain, testimonialPdaHex } from "../src/mock-backend.js";
import { NATIVE_ASSET_ID } from "../src/types.js";

const MATERIAL = { secretKey: "11".repeat(32), npk: "22".repeat(32), vpk: "33".repeat(32) };

describe("MockBackend accounts", () => {
  it("creates deterministic accounts from pinned key material", async () => {
    const b = new MockBackend();
    const a = await b.createAccount("private", "Alice", MATERIAL);
    const again = await b.createAccount("private", "Alice", MATERIAL);
    expect(a.address).toBe(again.address); // deterministic
    expect(a.npk).toBe(MATERIAL.npk);
    expect(a.vpk).toBe(MATERIAL.vpk);
    expect(a.address).not.toBe(
      (await b.createAccount("public", "Bob", { secretKey: "44".repeat(32) })).address,
    );
  });

  it("imports accounts from secret key material", async () => {
    const b = new MockBackend();
    const res = await b.importAccount("public", { secretKey: "55".repeat(32) });
    expect(res.secretKey).toBe("55".repeat(32));
    expect(b.state.accounts[res.address]).toBeDefined();
  });
});

describe("MockBackend balances", () => {
  it("starts at zero, mints via faucet and reports balances", async () => {
    const b = new MockBackend();
    const { address } = await b.createAccount("public", "A", MATERIAL);
    expect((await b.getBalance(address, "public", NATIVE_ASSET_ID)).amount).toBe("0");

    await b.faucet(address, NATIVE_ASSET_ID, "1000");
    expect((await b.getBalance(address, "public", NATIVE_ASSET_ID)).amount).toBe("1000");

    // tokens: faucet registers them on first mint
    const tokenId = "t".repeat(32);
    await b.faucet(address, tokenId, "500", 6);
    const all = await b.getAllBalances(address, "public");
    expect(all.map((x) => x.assetId)).toEqual([NATIVE_ASSET_ID, tokenId]);
    expect(all[1]).toMatchObject({ amount: "500", decimals: 6 });
  });

  it("private balances require a registered viewing key", async () => {
    const b = new MockBackend();
    const { address } = await b.createAccount("private", "P", MATERIAL);
    await b.faucet(address, NATIVE_ASSET_ID, "10");
    await expect(b.getBalance(address, "private", NATIVE_ASSET_ID)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(
      b.getBalance(address, "private", NATIVE_ASSET_ID, MATERIAL.vpk),
    ).resolves.toMatchObject({ amount: "10" });
    // an unregistered viewing key is still refused
    await expect(
      b.getBalance(address, "private", NATIVE_ASSET_ID, "66".repeat(32)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("MockBackend transfers", () => {
  it("moves funds and records a pending tx", async () => {
    const b = new MockBackend();
    const { address: from } = await b.createAccount("public", "A", MATERIAL);
    const { address: to } = await b.createAccount("public", "B", { secretKey: "44".repeat(32) });
    await b.faucet(from, NATIVE_ASSET_ID, "1000");
    const blockBefore = b.state.blockId;

    const { txHash } = await b.send(
      {
        fromAccountId: "acc_a",
        fromType: "public",
        fromAddress: from,
        toAddress: to,
        toType: "public",
        assetId: NATIVE_ASSET_ID,
        amount: "400",
      },
      [],
    );
    expect(txHash).toHaveLength(64);
    expect(b.state.blockId).toBe(blockBefore + 1);
    expect((await b.getBalance(from, "public", NATIVE_ASSET_ID)).amount).toBe("600");
    expect((await b.getBalance(to, "public", NATIVE_ASSET_ID)).amount).toBe("400");
    expect(b.state.txs[txHash]!.status).toBe("pending");
  });

  it("rejects insufficient balances, non-positive amounts and unknown accounts", async () => {
    const b = new MockBackend();
    const { address: from } = await b.createAccount("public", "A", MATERIAL);
    const { address: to } = await b.createAccount("public", "B", { secretKey: "44".repeat(32) });
    await b.faucet(from, NATIVE_ASSET_ID, "10");
    const req = {
      fromAccountId: "acc_a",
      fromType: "public" as const,
      fromAddress: from,
      toAddress: to,
      toType: "public" as const,
      assetId: NATIVE_ASSET_ID,
      amount: "10",
    };
    await expect(b.send({ ...req, amount: "11" }, [])).rejects.toMatchObject({
      code: "insufficient_balance",
    });
    await expect(b.send({ ...req, amount: "0" }, [])).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(b.send({ ...req, toAddress: "nobody" }, [])).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("private senders must present a viewing key voucher", async () => {
    const b = new MockBackend();
    const { address: from } = await b.createAccount("private", "P", MATERIAL);
    const { address: to } = await b.createAccount("public", "B", { secretKey: "44".repeat(32) });
    await b.faucet(from, NATIVE_ASSET_ID, "10");
    const req = {
      fromAccountId: "acc_p",
      fromType: "private" as const,
      fromAddress: from,
      toAddress: to,
      toType: "public" as const,
      assetId: NATIVE_ASSET_ID,
      amount: "5",
    };
    await expect(b.send(req, [])).rejects.toMatchObject({ code: "unauthorized" });
    await expect(b.send(req, [MATERIAL.vpk])).resolves.toHaveProperty("txHash");
  });
});

describe("MockBackend tx lifecycle and programs", () => {
  it("confirms after two polls and reports gas used", async () => {
    const b = new MockBackend();
    const { address: from } = await b.createAccount("public", "A", MATERIAL);
    const { address: to } = await b.createAccount("public", "B", { secretKey: "44".repeat(32) });
    await b.faucet(from, NATIVE_ASSET_ID, "10");
    const { txHash } = await b.send(
      {
        fromAccountId: "acc_a",
        fromType: "public",
        fromAddress: from,
        toAddress: to,
        toType: "public",
        assetId: NATIVE_ASSET_ID,
        amount: "1",
      },
      [],
    );
    expect((await b.pollTx(txHash)).status).toBe("pending");
    const done = await b.pollTx(txHash);
    expect(done.status).toBe("confirmed");
    expect(done.gasUsed).toBe("25000");
    await expect(b.pollTx("nonexistent")).rejects.toMatchObject({ code: "not_found" });
  });

  it("estimates gas and executes publishTestimonial", async () => {
    const b = new MockBackend();
    const { address } = await b.createAccount("public", "A", MATERIAL);
    expect(
      await b.estimateGas({
        fromAccountId: "acc_a",
        fromType: "public",
        fromAddress: address,
        toAddress: address,
        toType: "public",
        assetId: NATIVE_ASSET_ID,
        amount: "1",
      }),
    ).toEqual({ gas: "50000" });

    const { txHash } = await b.executeProgram(
      {
        fromAccountId: "acc_a",
        fromType: "public",
        fromAddress: address,
        toAddress: "",
        toType: "public",
        assetId: NATIVE_ASSET_ID,
        amount: "0",
        programId: "testimonial",
        instruction: "publishTestimonial",
        args: ["hello world", "alice", "sub-1", 0],
      },
      [],
    );
    expect(txHash).toHaveLength(64);
    const pda = await testimonialPdaHex("testimonial", address, "sub-1", 0);
    const st = await b.getState(address, "public", "testimonial");
    expect(st.data).toMatchObject({ text: "hello world", author: address, submissionId: "sub-1" });
    expect(b.state.accounts[address]!.programs[pda]).toBeDefined();

    await expect(
      b.executeProgram(
        {
          fromAccountId: "acc_a",
          fromType: "public",
          fromAddress: address,
          toAddress: "",
          toType: "public",
          assetId: NATIVE_ASSET_ID,
          amount: "0",
          programId: "testimonial",
          instruction: "nope",
        },
        [],
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("getState for private accounts requires the viewing key", async () => {
    const b = new MockBackend();
    const { address } = await b.createAccount("private", "P", MATERIAL);
    await expect(b.getState(address, "private", "testimonial")).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(
      b.getState(address, "private", "testimonial", MATERIAL.vpk),
    ).resolves.toMatchObject({ data: {} });
  });
});

describe("MockBackend offline mode", () => {
  it("throws rpc_unavailable for chain calls when offline", async () => {
    const b = new MockBackend({ offline: true });
    expect((await b.ping()).ok).toBe(false);
    await expect(b.getBalance("addr", "public", NATIVE_ASSET_ID)).rejects.toMatchObject({
      code: "rpc_unavailable",
    });
    await expect(b.currentBlockId()).rejects.toMatchObject({ code: "rpc_unavailable" });
    b.setOffline(false);
    expect((await b.ping()).ok).toBe(true);
    await expect(b.currentBlockId()).resolves.toBe(1);
    // emptyMockChain has a sane starting point
    expect(emptyMockChain().blockId).toBe(1);
  });
});
