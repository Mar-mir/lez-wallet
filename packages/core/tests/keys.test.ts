import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  deriveAccountKeys,
  entropyToMnemonic,
  generateMnemonic,
  hexToBytes,
  mnemonicToSeed,
  validateMnemonic,
} from "../src/keys.js";

// Official BIP-39 test vectors (trezor/python-mnemonic vectors.json, english).
const VECTORS: Array<{ entropy: string; mnemonic: string; seedTrezor: string }> = [
  {
    entropy: "00000000000000000000000000000000",
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    seedTrezor:
      "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04",
  },
  {
    entropy: "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
    mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
    seedTrezor:
      "2e8905819b8723fe2c1d161860e5ee1830318dbf49a83bd451cfb8440c28bd6fa457fe1296106559a3c80937a1c1069be3a3a5bd381ee6260e8d9739fce1f607",
  },
  {
    entropy: "80808080808080808080808080808080",
    mnemonic: "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
    seedTrezor:
      "d71de856f81a8acc65e6fc851a38d4d7ec216fd0796d0a6827a3ad6ed5511a30fa280f12eb2e47ed2ac03b5c462a0358d18d69fe4f985ec81778c1b370b652a8",
  },
  {
    entropy: "ffffffffffffffffffffffffffffffff",
    mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
    seedTrezor:
      "ac27495480225222079d7be181583751e86f571027b0497b5b5d11218e0a8a13332572917f0f8e5a589620c6f15b11c61dee327651a14c34e18231052e48c069",
  },
];

const isHex = (s: string): boolean => s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);

describe("BIP-39 mnemonics", () => {
  it("entropyToMnemonic matches official vectors", () => {
    for (const v of VECTORS) {
      expect(entropyToMnemonic(hexToBytes(v.entropy))).toBe(v.mnemonic);
    }
  });

  it("validateMnemonic returns the words for valid mnemonics", () => {
    for (const v of VECTORS) {
      expect(validateMnemonic(v.mnemonic)).toEqual(v.mnemonic.split(" "));
    }
  });

  it("validateMnemonic throws invalid_input on garbage", () => {
    // wrong word count
    expect(() => validateMnemonic("abandon abandon abandon")).toThrow(/12 or 24/);
    // not a BIP-39 word
    expect(() =>
      validateMnemonic(
        "notaword notaword notaword notaword notaword notaword notaword notaword notaword notaword notaword notaword",
      ),
    ).toThrow(/not a valid BIP-39 word/);
    // 12 valid words but invalid checksum (entropy all zeros checksums to "about")
    expect(() =>
      validateMnemonic(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon",
      ),
    ).toThrow(/checksum/);
  });

  it("mnemonicToSeed matches the official TREZOR-passphrase vectors", async () => {
    for (const v of VECTORS) {
      expect(await mnemonicToSeed(v.mnemonic, "TREZOR")).toBe(v.seedTrezor);
    }
  });

  it("mnemonicToSeed is deterministic, 512-bit and passphrase-sensitive", async () => {
    const m = VECTORS[0]!.mnemonic;
    const empty = await mnemonicToSeed(m, "");
    expect(empty).toHaveLength(128); // 64 bytes
    expect(isHex(empty)).toBe(true);
    expect(await mnemonicToSeed(m, "")).toBe(empty);
    expect(await mnemonicToSeed(m, "other")).not.toBe(empty);
    // canonical empty-passphrase vector for vector 1
    expect(empty).toBe(
      "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
    );
  });

  it("generateMnemonic round-trips through validateMnemonic (12 and 24 words)", () => {
    for (const words of [12, 24] as const) {
      const m = generateMnemonic(words);
      expect(m.split(" ")).toHaveLength(words);
      expect(validateMnemonic(m)).toHaveLength(words);
    }
    // deterministic vectors are stable under whitespace/case normalization
    expect(validateMnemonic(`  ${VECTORS[1]!.mnemonic.toUpperCase()}  `)).toEqual(
      VECTORS[1]!.mnemonic.split(" "),
    );
  });

  it("round-trips 32-byte entropy through entropyToMnemonic + validateMnemonic", () => {
    const entropy = new Uint8Array(32);
    crypto.getRandomValues(entropy);
    const m = entropyToMnemonic(entropy);
    expect(m.split(" ")).toHaveLength(24);
    expect(validateMnemonic(m)).toHaveLength(24);
  });

  it("rejects invalid entropy sizes", () => {
    expect(() => entropyToMnemonic(new Uint8Array(15))).toThrow(/16 or 32/);
    expect(() => entropyToMnemonic(new Uint8Array(24))).toThrow(/16 or 32/);
  });
});

describe("account key derivation", () => {
  const seed = VECTORS[0]!.seedTrezor;

  it("is deterministic and index/type-separated", () => {
    const a = deriveAccountKeys(seed, "private", 0);
    const b = deriveAccountKeys(seed, "private", 0);
    const c = deriveAccountKeys(seed, "private", 1);
    const d = deriveAccountKeys(seed, "public", 0);
    expect(a).toEqual(b);
    expect(a.npk).not.toBe(c.npk);
    expect(a.npk).not.toBe(d.npk);
  });

  it("produces well-formed 32-byte hex material", () => {
    const k = deriveAccountKeys(seed, "private", 7);
    for (const field of [k.secretKey, k.publicKey, k.npk, k.vpk]) {
      expect(field).toHaveLength(64); // 32 bytes
      expect(isHex(field)).toBe(true);
    }
  });
});

describe("hex utilities", () => {
  it("bytesToHex/hexToBytes round-trip", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 254, 255]);
    expect(bytesToHex(bytes)).toBe("00010f10feff");
    expect(bytesToHex(hexToBytes("00010f10feff"))).toBe("00010f10feff");
    // 0x prefix is tolerated
    expect(bytesToHex(hexToBytes("0x00ff"))).toBe("00ff");
  });

  it("hexToBytes rejects malformed input", () => {
    expect(() => hexToBytes("f0f")).toThrow(/invalid hex/); // odd length
    expect(() => hexToBytes("zz")).toThrow(/invalid hex/);
  });
});

