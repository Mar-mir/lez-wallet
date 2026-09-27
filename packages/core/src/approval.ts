// Dual-licensed: MIT OR Apache-2.0
/**
 * ApprovalService — dApp origin approvals and capability checks (LP-0021).
 *
 * Every dApp entry point must flow through requireApproval(); the prompt is
 * injected (CLI prompt / extension popup) and its rejection maps to the
 * canonical `rejected_by_user` code. Missing/expired grants resolve to
 * `unauthorized`. Grants are stored in WalletState.approvals keyed by origin,
 * scoped to exactly one accountId (last grant wins).
 */
import { rejectedByUser, rpcUnavailable, unauthorized } from "./errors.js";
import type { StateManager } from "./store.js";

/** Capabilities a dApp may be granted for one account. */
export type Capability = "read_balance" | "read_state" | "propose_tx" | "read_keys";

export interface ApprovalRequest {
  origin: string;
  accountId: string;
  capabilities: Capability[];
  note?: string;
}

/** Stored grant — the shape persisted in WalletState.approvals[origin]. */
export interface ApprovalGrant {
  accountId: string;
  grantedAt: string;
  permissions: string[];
}

/** Injected UI hook: resolve true to grant, false to reject. */
export type ApprovalPrompt = (req: ApprovalRequest) => Promise<boolean>;

export class ApprovalService {
  private prompt: ApprovalPrompt | null;

  constructor(private readonly state: StateManager, prompt?: ApprovalPrompt) {
    this.prompt = prompt ?? null;
  }

  /** Swap the prompt hook (the extension binds its popup after startup). */
  setPrompt(prompt: ApprovalPrompt | null): void {
    this.prompt = prompt;
  }

  /**
   * Gate a privileged action for `origin`. Skips prompting when an existing
   * grant already covers the same account + every requested capability —
   * unless `alwaysPrompt` is set, which LP-0021 requires for transaction
   * submissions and key exports (the user confirms each one explicitly).
   * On approval the stored grant is updated: same account → permissions
   * merge (a per-tx confirm never drops read caps); different account →
   * the grant is replaced (last grant wins).
   */
  async requireApproval(req: ApprovalRequest, opts?: { alwaysPrompt?: boolean }): Promise<void> {
    const existing = await this.getGrant(req.origin);
    if (
      !opts?.alwaysPrompt &&
      existing &&
      existing.accountId === req.accountId &&
      req.capabilities.every((c) => existing.permissions.includes(c))
    ) {
      return;
    }
    if (!this.prompt) throw rpcUnavailable("no approval prompt is bound");
    const granted = await this.prompt(req);
    if (!granted) throw rejectedByUser();
    await this.state.update((s) => {
      const prev = s.approvals[req.origin];
      const permissions =
        prev && prev.accountId === req.accountId
          ? [...new Set([...prev.permissions, ...req.capabilities])]
          : [...req.capabilities];
      s.approvals[req.origin] = {
        accountId: req.accountId,
        grantedAt: new Date().toISOString(),
        permissions,
      };
    });
  }

  /** Throws `unauthorized` unless origin holds a grant for (accountId, cap). */
  async requireCapability(origin: string, accountId: string, cap: Capability): Promise<void> {
    const grant = await this.getGrant(origin);
    if (!grant || grant.accountId !== accountId || !grant.permissions.includes(cap)) {
      throw unauthorized(`origin ${origin} lacks ${cap} for ${accountId}`);
    }
  }

  async getGrant(origin: string): Promise<ApprovalGrant | null> {
    const s = await this.state.read();
    return s.approvals[origin] ?? null;
  }

  async list(): Promise<ApprovalGrant[]> {
    const s = await this.state.read();
    return Object.values(s.approvals);
  }

  async revoke(origin: string): Promise<void> {
    await this.state.update((s) => {
      delete s.approvals[origin];
    });
  }
}