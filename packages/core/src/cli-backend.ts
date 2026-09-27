// Dual-licensed: MIT OR Apache-2.0
/**
 * CliBackend — drives the official LEZ `wallet` CLI (Rust) for all on-chain
 * operations: account registration, balance reads, native/token transfers and
 * sequencer polling. The heavy lifting (key registration, ZK proof
 * generation, submission) happens inside the official binary; this backend is
 * a thin, defensive parser around its JSON stdout.
 *
 * Reference: https://github.com/logos-blockchain/logos-execution-zone
 * (wallet subcommands: account, token, auth-transfer, chain-info, config,
 * check-health, deploy-program, ...).
 *
 * Gas estimate: the official CLI exposes no gas-estimate subcommand, so
 * estimateGas() returns null — callers must handle the null per LP-0021.
 *
 * Arbitrary program calls (testimonial etc.) are delegated to the `spel` CLI
 * when available (see executeProgram).
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WalletError, ioError } from "./errors.js";
import {
  AccountState,
  AccountType,
  Balance,
  DEFAULT_NETWORK,
  NetworkConfig,
  TxRecord,
} from "./types.js";
import type { Backend, CreateAccountResult, GasEstimate, SendRequest } from "./backend.js";

export interface CliBackendOptions {
  /**
   * LEZ wallet home dir. Default: $LEE_WALLET_HOME_DIR (the official variable
   * used by the wallet CLI), then $LEZ_WALLET_HOME_DIR (alias), then
   * ~/.lez-wallet-home.
   */
  homeDir?: string;
  /** Path/name of the wallet binary. Default: "wallet". */
  walletBin?: string;
  /** Path/name of the spel CLI (for arbitrary program calls). Optional. */
  spelBin?: string;
  /** Per-command timeout ms. Default 60s (proof gen can be slow). */
  timeoutMs?: number;
  /** Environment override for the subprocess. */
  env?: Record<string, string>;
  /** Test hook: override command execution. */
  runner?: (bin: string, args: string[], env: Record<string, string>) => Promise<RunResult>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface WalletConfig {
  sequencers: { sequencer_addr: string }[];
  seq_poll_timeout: string;
  seq_tx_poll_max_blocks: number;
  seq_poll_max_retries: number;
  seq_block_poll_max_amount: number;
  multi_sequencer_client_config: { distribution_limit: number; calibration_limit: number };
}

function firstLines(s: string, n = 3): string {
  return s.split("\n").slice(0, n).join(" | ").slice(0, 400);
}

/** "public" -> "Public" (the CLI's privacy_prefix spelling). */
function capPrivacy(t: AccountType): string {
  return t === "private" ? "Private" : "Public";
}

function pickField(obj: Record<string, unknown>, names: string[]): string | undefined {
  for (const n of names) {
    const v = obj[n];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export class CliBackend implements Backend {
  readonly kind = "cli" as const;
  readonly network: NetworkConfig;
  private readonly homeDir: string;
  private readonly walletBin: string;
  private readonly spelBin: string | undefined;
  private readonly timeoutMs: number;
  private readonly env: Record<string, string>;
  private readonly runner: (
    bin: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<RunResult>;

  constructor(opts: CliBackendOptions = {}) {
    this.network = DEFAULT_NETWORK;
    this.homeDir =
      opts.homeDir ??
      process.env.LEE_WALLET_HOME_DIR ??
      process.env.LEZ_WALLET_HOME_DIR ??
      path.join(os.homedir(), ".lez-wallet-home");
    this.walletBin = opts.walletBin ?? "wallet";
    this.spelBin = opts.spelBin;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.env = { ...(process.env as Record<string, string>), ...(opts.env ?? {}) };
    this.runner =
      opts.runner ??
      ((bin, args, env) =>
        new Promise<RunResult>((resolve) => {
          execFile(
            bin,
            args,
            { env, timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
            (err, stdout, stderr) => {
              resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
            },
          );
        }));
  }

  /** Ensure the wallet home exists with a config for our sequencer. */
  async ensureHome(): Promise<void> {
    await fs.mkdir(this.homeDir, { recursive: true });
    const cfgPath = path.join(this.homeDir, "wallet_config.json");
    try {
      await fs.access(cfgPath);
    } catch {
      const cfg: WalletConfig = {
        sequencers: [{ sequencer_addr: `${this.network.sequencerUrl.replace(/\/+$/, "")}/` }],
        seq_poll_timeout: "12s",
        seq_tx_poll_max_blocks: 5,
        seq_poll_max_retries: 5,
        seq_block_poll_max_amount: 100,
        multi_sequencer_client_config: { distribution_limit: 1, calibration_limit: 100 },
      };
      const tmp = `${cfgPath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
      await fs.rename(tmp, cfgPath);
    }
  }

  private async run(args: string[]): Promise<RunResult> {
    await this.ensureHome();
    return this.runner(this.walletBin, args, { ...this.env, LEE_WALLET_HOME_DIR: this.homeDir });
  }

  /** Run a wallet subcommand and require a clean exit. */
  private async runOk(args: string[]): Promise<RunResult> {
    const res = await this.run(args);
    if (res.code !== 0) {
      throw ioError(
        `wallet ${args[0]} ${args[1] ?? ""} failed (exit ${res.code}): ${firstLines(res.stderr || res.stdout)}`,
      );
    }
    return res;
  }

  /** Parse JSON stdout; the wallet emits JSON for most subcommands. */
  private parseJson(res: RunResult, context: string): Record<string, unknown> {
    const text = res.stdout.trim();
    if (!text) throw ioError(`wallet ${context}: empty output`);
    const tryParse = (s: string): Record<string, unknown> | undefined => {
      try {
        const v = JSON.parse(s) as unknown;
        return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    };
    const obj = tryParse(text) ?? tryParse(text.slice(text.indexOf("{")));
    if (!obj) throw ioError(`wallet ${context}: non-JSON output: ${firstLines(text)}`);
    return obj;
  }

  async ping(): Promise<{ ok: boolean; info?: string }> {
    try {
      const res = await this.runOk(["chain-info", "current-block-id"]);
      return { ok: true, info: `block ${firstLines(res.stdout).trim()}` };
    } catch (e) {
      return { ok: false, info: (e as Error).message };
    }
  }

  async createAccount(type: AccountType, label: string): Promise<CreateAccountResult> {
    const args =
      type === "public"
        ? ["account", "new", "public", ...(label ? ["--label", label] : [])]
        : ["account", "new", "private", ...(label ? ["--label", label] : [])];
    const res = await this.runOk(args);
    const obj = this.parseJson(res, args.join(" "));
    const address = pickField(obj, ["address", "account_id", "accountId", "id"]);
    if (!address) throw ioError(`wallet account new: no address in output: ${firstLines(res.stdout)}`);
    return {
      address,
      npk: pickField(obj, ["npk", "null_path_key", "nullPathKey"]),
      vpk: pickField(obj, ["vpk", "viewing_key", "viewingKey"]),
      secretKey: pickField(obj, ["secret_key", "private_key", "secretKey", "signing_key"]),
    };
  }

  async importAccount(
    type: AccountType,
    material: { secretKey?: string; keyChainJson?: string; accountState?: string },
  ): Promise<CreateAccountResult> {
    if (type === "public") {
      if (!material.secretKey) {
        throw new WalletError("public import needs secretKey (hex)", "invalid_input");
      }
      const res = await this.runOk([
        "account", "import", "public", "--private-key", material.secretKey,
      ]);
      const obj = this.parseJson(res, "account import public");
      const address = pickField(obj, ["address", "account_id", "accountId", "id"]);
      if (!address) throw ioError(`wallet account import: no address in output: ${firstLines(res.stdout)}`);
      return { address };
    }
    if (!material.keyChainJson || !material.accountState) {
      throw new WalletError("private import needs keyChainJson + accountState", "invalid_input");
    }
    const res = await this.runOk([
      "account", "import", "private",
      "--key-chain-json", material.keyChainJson,
      "--account-state", material.accountState,
    ]);
    const obj = this.parseJson(res, "account import private");
    const address = pickField(obj, ["address", "account_id", "accountId", "id"]);
    if (!address) throw ioError(`wallet account import: no address in output: ${firstLines(res.stdout)}`);
    return {
      address,
      npk: pickField(obj, ["npk", "null_path_key", "nullPathKey"]),
      vpk: pickField(obj, ["vpk", "viewing_key", "viewingKey"]),
    };
  }

  async getBalance(
    accountId: string,
    accountType: AccountType,
    assetId: string,
    _viewingKey?: string,
  ): Promise<Balance> {
    // `account get` returns account data incl. the native balance; for
    // private accounts the wallet reads state with the local viewing key
    // (the keychain lives in the wallet home).
    const prefixed = accountType === "private" ? `Private/${accountId}` : `Public/${accountId}`;
    const res = await this.runOk(["account", "get", "--account-id", prefixed]);
    const obj = this.parseJson(res, "account get");
    return balanceFromAccountJson(obj, assetId);
  }

  async getAllBalances(
    accountId: string,
    accountType: AccountType,
    _viewingKey?: string,
  ): Promise<Balance[]> {
    const balances = await this.getBalance(accountId, accountType, "");
    return [balances];
    // Fungible token balances are read per token definition account via the
    // same `account get` path in the full implementation.
  }

  async send(req: SendRequest, _vouchers: string[]): Promise<{ txHash: string }> {
    // All account ids on the CLI need the {privacy_prefix}/{account_id} form.
    const from = `${capPrivacy(req.fromType)}/${req.fromAddress}`;
    // `--to` and `--to-npk`/`--to-vpk` are mutually exclusive patterns:
    // owned receivers use `--to`, FOREIGN private receivers use the key pair.
    const toFlags = req.toNpk
      ? [
          "--to-npk", req.toNpk,
          ...(req.toVpk ? ["--to-vpk", req.toVpk] : []),
          ...(req.toIdentifier !== undefined
            ? ["--to-identifier", String(req.toIdentifier)]
            : []),
        ]
      : ["--to", `${capPrivacy(req.toType)}/${req.toAddress}`];
    const program = req.assetId === "" ? "auth-transfer" : "token";
    const args = [program, "send", "--from", from, ...toFlags, "--amount", req.amount];
    const res = await this.runOk(args);
    return { txHash: pickHash(this.parseJson(res, `${program} send`), res.stdout) };
  }

  async executeProgram(req: SendRequest, _vouchers: string[]): Promise<{ txHash: string }> {
    if (!req.programId || !req.instruction) {
      throw new WalletError("executeProgram requires programId + instruction", "invalid_input");
    }
    if (!this.spelBin) {
      throw new WalletError(
        "the official wallet CLI has no generic program-call subcommand; " +
          "install the `spel` CLI and set LEZ_WALLET_SPEL_BIN to use contract programs",
        "io_error",
      );
    }
    const args = [
      "-p", req.programId,
      "--", req.instruction,
      "--payer", req.fromAddress,
      ...argFlags(req.args ?? []),
    ];
    const res = await this.runner(this.spelBin, args, {
      ...this.env,
      LEE_WALLET_HOME_DIR: this.homeDir,
    });
    if (res.code !== 0) {
      throw ioError(
        `spel ${req.instruction} failed (exit ${res.code}): ${firstLines(res.stderr || res.stdout)}`,
      );
    }
    return { txHash: pickHash(this.parseJson(res, `spel ${req.instruction}`), res.stdout) };
  }

  async estimateGas(_req: SendRequest): Promise<GasEstimate | null> {
    // The official CLI has no gas-estimate subcommand: return null gracefully
    // (LP-0021 rule — never crash on a missing estimate).
    return null;
  }

  async pollTx(
    txHash: string,
  ): Promise<Pick<TxRecord, "hash" | "status" | "gasUsed" | "error">> {
    const res = await this.runOk(["chain-info", "transaction", "--hash", txHash]);
    const obj = this.parseJson(res, "chain-info transaction");
    const statusRaw = String(obj["status"] ?? obj["state"] ?? obj["tx_status"] ?? "confirmed").toLowerCase();
    const status =
      statusRaw === "pending" || statusRaw === "queued"
        ? "pending"
        : statusRaw === "failed" || statusRaw === "reverted"
          ? "failed"
          : "confirmed";
    const gasUsed = pickField(obj, ["gas_used", "gasUsed"]) ?? "";
    const error = pickField(obj, ["error", "failure_reason", "failureReason"]);
    return { hash: txHash, status, gasUsed, ...(error ? { error } : {}) };
  }

  async getState(
    accountId: string,
    accountType: AccountType,
    programId: string,
    _viewingKey?: string,
  ): Promise<AccountState> {
    const prefixed = accountType === "private" ? `Private/${accountId}` : `Public/${accountId}`;
    const res = await this.runOk(["account", "get", "-r", "--account-id", prefixed]);
    const obj = this.parseJson(res, "account get");
    const raw = pickField(obj, ["raw", "data", "raw_data", "rawData"]) ?? "";
    return { accountId, programId, data: { raw }, raw };
  }

  async currentBlockId(): Promise<number> {
    const res = await this.runOk(["chain-info", "current-block-id"]);
    const obj = this.parseJson(res, "chain-info current-block-id");
    const v = obj["block_id"] ?? obj["blockId"] ?? obj["current_block_id"] ?? obj["id"];
    const n = typeof v === "number" ? v : Number(firstLines(res.stdout).replace(/[^0-9]/g, ""));
    if (!Number.isFinite(n)) {
      throw ioError(`could not parse current block id from: ${firstLines(res.stdout)}`);
    }
    return n;
  }
}

function pickHash(obj: Record<string, unknown>, rawStdout: string): string {
  const v = pickField(obj, ["tx_hash", "transaction_hash", "hash", "txHash", "id"]);
  if (v) return v;
  const m = rawStdout.match(/[0-9a-f]{64}/);
  if (m) return m[0]!;
  throw ioError(`could not find tx hash in: ${firstLines(rawStdout)}`);
}

function balanceFromAccountJson(obj: Record<string, unknown>, assetId: string): Balance {
  const balanceRaw = obj["balance"] ?? obj["native_balance"] ?? obj["amount"] ?? "0";
  const amount = typeof balanceRaw === "string" ? balanceRaw : String(balanceRaw);
  const symbol = pickField(obj, ["symbol"]) ?? "LOG";
  const decimals = Number(obj["decimals"] ?? 9);
  return { assetId: assetId || "", assetSymbol: symbol, assetName: symbol, amount, decimals };
}

function argFlags(args: unknown[]): string[] {
  const flags: string[] = [];
  for (const a of args) {
    if (a === null || a === undefined) continue;
    flags.push(String(a));
  }
  return flags;
}