// Dual-licensed: MIT OR Apache-2.0
/**
 * Asset metadata and amount math. All amounts are base-unit integer strings —
 * never floats — so formatting/parsing is exact at any decimal count.
 */
import { invalidInput } from "./errors.js";
import {
  Balance,
  NATIVE_ASSET_DECIMALS,
  NATIVE_ASSET_ID,
  NATIVE_ASSET_SYMBOL,
} from "./types.js";

const AMOUNT_RE = /^\d+(\.\d+)?$/;

/** True for the native LEZ asset (assetId === ""). */
export function isNativeAsset(assetId: string): boolean {
  return assetId === NATIVE_ASSET_ID;
}

/** Validate a token definition account id (32-byte base58) for non-native assets. */
export function isValidAssetId(assetId: string): boolean {
  return isNativeAsset(assetId) || (assetId.length >= 32 && assetId.length <= 64);
}

export function assertAssetId(assetId: string): void {
  if (!isValidAssetId(assetId)) {
    throw invalidInput(`invalid asset id: ${assetId.slice(0, 24)}`);
  }
}

/**
 * Parse a human decimal amount ("1.5") into base units ("1500000000").
 * Throws invalid_input on malformed input or excess fractional digits.
 */
export function parseAmount(input: string, decimals: number): string {
  const s = input.trim();
  if (!AMOUNT_RE.test(s)) throw invalidInput(`invalid amount: "${input}"`);
  const [wholeRaw = "0", fracRaw = ""] = s.split(".");
  if (fracRaw.length > decimals) {
    throw invalidInput(`amount "${input}" has more than ${decimals} decimal places`);
  }
  const frac = fracRaw.padEnd(decimals, "0");
  const base = BigInt(wholeRaw) * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return base.toString();
}

/**
 * Format base units as a human decimal string. Trailing zeros are trimmed
 * ("1500000000" -> "1.5"); `minFraction` keeps at least N decimals.
 */
export function formatAmount(
  amount: string,
  decimals: number,
  opts: { minFraction?: number; maxFraction?: number } = {},
): string {
  const value = parseBaseUnits(amount);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let frac = (abs % scale).toString().padStart(decimals, "0");
  const maxFraction = Math.min(decimals, opts.maxFraction ?? decimals);
  frac = frac.slice(0, maxFraction);
  frac = frac.replace(/0+$/, "");
  const minFraction = Math.min(maxFraction, opts.minFraction ?? 0);
  while (frac.length < minFraction) frac += "0";
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

function parseBaseUnits(amount: string): bigint {
  if (!/^-?\d+$/.test(amount)) throw invalidInput(`invalid base-unit amount: "${amount}"`);
  return BigInt(amount);
}

export function addAmounts(a: string, b: string): string {
  return (parseBaseUnits(a) + parseBaseUnits(b)).toString();
}

export function subAmounts(a: string, b: string): string {
  return (parseBaseUnits(a) - parseBaseUnits(b)).toString();
}

/** -1 | 0 | 1 comparison of two base-unit amounts. */
export function cmpAmounts(a: string, b: string): -1 | 0 | 1 {
  const d = parseBaseUnits(a) - parseBaseUnits(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

export function isPositiveAmount(a: string): boolean {
  return parseBaseUnits(a) > 0n;
}

/** Balance view of the native LEZ asset at the given base-unit amount. */
export function nativeAsset(amount = "0"): Balance {
  return {
    assetId: NATIVE_ASSET_ID,
    assetSymbol: NATIVE_ASSET_SYMBOL,
    assetName: "Logos (native)",
    amount,
    decimals: NATIVE_ASSET_DECIMALS,
  };
}

/** Balance view of a fungible token at the given base-unit amount. */
export function tokenAsset(
  definitionId: string,
  meta: { name: string; symbol: string; decimals: number },
  amount = "0",
): Balance {
  assertAssetId(definitionId);
  return {
    assetId: definitionId,
    assetSymbol: meta.symbol,
    assetName: meta.name,
    amount,
    decimals: meta.decimals,
  };
}