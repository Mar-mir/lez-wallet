// Dual-licensed: MIT OR Apache-2.0
/** Typed errors. The four SDK-level codes match the LP-0021 spec exactly. */

export type ErrorCode =
  | "rejected_by_user" // user dismissed/rejected a prompt
  | "unauthorized" // no approval for this account/operation
  | "account_locked" // wallet locked, unlock required
  | "rpc_unavailable" // sequencer / node unreachable
  | "password_invalid"
  | "no_password_set"
  | "not_found"
  | "insufficient_balance"
  | "invalid_input"
  | "io_error"
  | "unknown";

export class WalletError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode = "unknown",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WalletError";
    if (cause !== undefined) {
      try {
        (this as { cause: unknown }).cause = cause;
      } catch {
        /* older engines */
      }
    }
  }
}

export const rejectedByUser = (message = "Rejected by user") =>
  new WalletError(message, "rejected_by_user");
export const unauthorized = (message = "Not authorized") =>
  new WalletError(message, "unauthorized");
export const accountLocked = (message = "Wallet is locked") =>
  new WalletError(message, "account_locked");
export const rpcUnavailable = (message = "Sequencer/RPC unavailable", cause?: unknown) =>
  new WalletError(message, "rpc_unavailable", cause);
export const passwordInvalid = (message = "Wrong password") =>
  new WalletError(message, "password_invalid");
export const noPasswordSet = (message = "No password set yet") =>
  new WalletError(message, "no_password_set");
export const notFound = (message: string) => new WalletError(message, "not_found");
export const insufficientBalance = (message = "Insufficient balance") =>
  new WalletError(message, "insufficient_balance");
export const invalidInput = (message = "Invalid input") =>
  new WalletError(message, "invalid_input");
export const ioError = (message: string, cause?: unknown) =>
  new WalletError(message, "io_error", cause);
