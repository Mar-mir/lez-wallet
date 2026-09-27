import { describe, expect, it } from "vitest";
import { ApprovalService, type ApprovalRequest } from "../src/approval.js";
import { MemoryStateStorage, StateManager } from "../src/store.js";

const REQ: ApprovalRequest = {
  origin: "https://dapp.example",
  accountId: "acc_1",
  capabilities: ["read_balance", "propose_tx"],
};

function setup(promptResult: boolean) {
  const state = new StateManager(new MemoryStateStorage());
  const calls: ApprovalRequest[] = [];
  const prompt = async (req: ApprovalRequest) => {
    calls.push(req);
    return promptResult;
  };
  return { state, calls, service: new ApprovalService(state, prompt) };
}

describe("ApprovalService.requireApproval", () => {
  it("grants and stores the grant on user approval", async () => {
    const { calls, service } = setup(true);
    await service.requireApproval(REQ);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(REQ);

    const grant = await service.getGrant(REQ.origin);
    expect(grant).toMatchObject({
      accountId: "acc_1",
      permissions: ["read_balance", "propose_tx"],
    });
    expect(typeof grant!.grantedAt).toBe("string");
    expect(await service.list()).toHaveLength(1);
  });

  it("maps prompt rejection to rejected_by_user and stores nothing", async () => {
    const { service } = setup(false);
    await expect(service.requireApproval(REQ)).rejects.toMatchObject({
      code: "rejected_by_user",
    });
    expect(await service.getGrant(REQ.origin)).toBeNull();
  });

  it("skips the prompt when an existing grant already covers the request", async () => {
    const { calls, service } = setup(true);
    await service.requireApproval(REQ);
    await service.requireApproval({ ...REQ, capabilities: ["read_balance"] }); // subset
    expect(calls).toHaveLength(1);

    // a new capability re-prompts and merges into the grant
    await service.requireApproval({ ...REQ, capabilities: ["read_keys"] });
    expect(calls).toHaveLength(2);
    const grant = await service.getGrant(REQ.origin);
    expect(grant!.permissions.sort()).toEqual(["propose_tx", "read_balance", "read_keys"]);
  });

  it("alwaysPrompt confirms every call and maps a veto to rejected_by_user", async () => {
    const { calls, service } = setup(true);
    await service.requireApproval(REQ);
    await service.requireApproval(REQ, { alwaysPrompt: true });
    await service.requireApproval(REQ, { alwaysPrompt: true });
    expect(calls).toHaveLength(3); // a covering grant does NOT skip the prompt

    const deny = setup(false);
    await expect(
      deny.service.requireApproval(REQ, { alwaysPrompt: true }),
    ).rejects.toMatchObject({ code: "rejected_by_user" });
  });

  it("re-prompts when the grant belongs to a different account", async () => {
    const { calls, service } = setup(true);
    await service.requireApproval(REQ);
    await service.requireApproval({ ...REQ, accountId: "acc_2" });
    expect(calls).toHaveLength(2);
    expect((await service.getGrant(REQ.origin))!.accountId).toBe("acc_2");
  });

  it("throws rpc_unavailable when no prompt is bound", async () => {
    const service = new ApprovalService(new StateManager(new MemoryStateStorage()));
    await expect(service.requireApproval(REQ)).rejects.toMatchObject({
      code: "rpc_unavailable",
    });
  });
});

describe("ApprovalService.requireCapability", () => {
  it("enforces (origin, account, capability) tuples", async () => {
    const { service } = setup(true);
    await service.requireApproval(REQ);

    await expect(service.requireCapability(REQ.origin, "acc_1", "read_balance")).resolves.toBeUndefined();
    // missing capability
    await expect(service.requireCapability(REQ.origin, "acc_1", "read_keys")).rejects.toMatchObject({
      code: "unauthorized",
    });
    // wrong account
    await expect(service.requireCapability(REQ.origin, "acc_2", "read_balance")).rejects.toMatchObject({
      code: "unauthorized",
    });
    // unknown origin
    await expect(service.requireCapability("https://evil.example", "acc_1", "read_balance")).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});

describe("ApprovalService.revoke", () => {
  it("removes the grant so capability checks fail again", async () => {
    const { service } = setup(true);
    await service.requireApproval(REQ);
    await service.revoke(REQ.origin);
    expect(await service.getGrant(REQ.origin)).toBeNull();
    expect(await service.list()).toEqual([]);
    await expect(service.requireCapability(REQ.origin, "acc_1", "read_balance")).rejects.toMatchObject({
      code: "unauthorized",
    });
    await service.revoke("https://never-granted.example"); // idempotent
  });
});
