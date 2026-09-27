import { describe, expect, it } from "vitest";
import {
  addAmounts,
  cmpAmounts,
  formatAmount,
  isNativeAsset,
  isPositiveAmount,
  isValidAssetId,
  nativeAsset,
  parseAmount,
  subAmounts,
  tokenAsset,
} from "../src/assets.js";

describe("parseAmount", () => {
  it("parses human decimals into base units exactly", () => {
    expect(parseAmount("1", 9)).toBe("1000000000");
    expect(parseAmount("1.5", 9)).toBe("1500000000");
    expect(parseAmount("0.000000001", 9)).toBe("1");
    expect(parseAmount("0", 9)).toBe("0");
    expect(parseAmount("1234.56", 2)).toBe("123456");
    expect(parseAmount(" 42 ", 0)).toBe("42");
    // big values stay exact (no float rounding)
    expect(parseAmount("123456789012345678901234567890.5", 2)).toBe(
      "12345678901234567890123456789050",
    );
  });

  it("rejects malformed amounts and excess precision", () => {
    for (const bad of ["", "abc", "-1", "1.2.3", "1,5", ".5."]) {
      expect(() => parseAmount(bad, 9)).toThrow(/invalid amount/);
    }
    expect(() => parseAmount("0.0000000001", 9)).toThrow(/decimal places/);
    expect(() => parseAmount("1.111", 2)).toThrow(/decimal places/);
  });
});

describe("formatAmount", () => {
  it("formats base units and trims trailing zeros", () => {
    expect(formatAmount("1500000000", 9)).toBe("1.5");
    expect(formatAmount("1000000000", 9)).toBe("1");
    expect(formatAmount("1", 9)).toBe("0.000000001");
    expect(formatAmount("0", 9)).toBe("0");
  });

  it("honors minFraction and maxFraction", () => {
    expect(formatAmount("1000000000", 9, { minFraction: 2 })).toBe("1.00");
    expect(formatAmount("1500000000", 9, { maxFraction: 1 })).toBe("1.5");
    expect(formatAmount("1567000000", 9, { maxFraction: 2 })).toBe("1.56");
    expect(formatAmount("1000000000", 9, { minFraction: 3, maxFraction: 3 })).toBe("1.000");
  });

  it("round-trips with parseAmount", () => {
    for (const human of ["1", "1.5", "0.000000001", "987654321.123456789"]) {
      expect(formatAmount(parseAmount(human, 9), 9)).toBe(human);
    }
  });

  it("rejects non-integer base-unit input", () => {
    expect(() => formatAmount("1.5", 9)).toThrow(/base-unit/);
    expect(() => formatAmount("abc", 9)).toThrow(/base-unit/);
  });
});

describe("amount arithmetic", () => {
  it("adds, subtracts and compares exactly", () => {
    expect(addAmounts("1", "2")).toBe("3");
    expect(addAmounts("999999999999999999999", "1")).toBe("1000000000000000000000");
    expect(subAmounts("5", "3")).toBe("2");
    expect(subAmounts("3", "5")).toBe("-2");
    expect(cmpAmounts("1", "2")).toBe(-1);
    expect(cmpAmounts("2", "2")).toBe(0);
    expect(cmpAmounts("3", "2")).toBe(1);
    // no float drift: 0.1 + 0.2 style sums are exact in base units
    expect(addAmounts("100000000", "200000000")).toBe("300000000");
  });

  it("isPositiveAmount only accepts amounts > 0", () => {
    expect(isPositiveAmount("1")).toBe(true);
    expect(isPositiveAmount("0")).toBe(false);
    expect(isPositiveAmount("-1")).toBe(false);
  });
});

describe("asset helpers", () => {
  it("identifies the native asset and validates token ids", () => {
    expect(isNativeAsset("")).toBe(true);
    expect(isValidAssetId("")).toBe(true);
    expect(isValidAssetId("a".repeat(32))).toBe(true);
    expect(isValidAssetId("short")).toBe(false);
    expect(isValidAssetId("b".repeat(65))).toBe(false);
  });

  it("builds balance views", () => {
    expect(nativeAsset("1000")).toMatchObject({
      assetId: "",
      assetSymbol: "LOG",
      amount: "1000",
      decimals: 9,
    });
    const tok = tokenAsset("c".repeat(32), { name: "Test", symbol: "TST", decimals: 6 }, "5");
    expect(tok).toMatchObject({ assetSymbol: "TST", amount: "5", decimals: 6 });
    expect(() => tokenAsset("nope", { name: "x", symbol: "X", decimals: 2 })).toThrow(
      /invalid asset id/,
    );
  });
});
