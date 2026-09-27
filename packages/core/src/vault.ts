// Dual-licensed: MIT OR Apache-2.0
/**
 * PasswordVault — encrypts wallet secrets at rest with AES-GCM under a key
 * derived from the user password (PBKDF2-HMAC-SHA256, 210k iterations).
 *
 * - setPassword / verifyPassword manage the vault; a wrong password is a
 *   clean error (password_invalid) and NEVER wipes data.
 * - put/get encrypt + persist named JSON secrets through the provided storage
 *   backend (file in Node, chrome.storage in the extension).
 * - The AES key only exists in memory while the wallet is unlocked; lock()
 *   drops it (MV3-safe: storage-based persistence across service-worker sleep).
 */
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  bytesToHex,
  hexToBytes,
  pbkdf2Key,
  randomBytes,
  timingSafeEqual,
} from "./crypto.js";
import { WalletError, passwordInvalid, noPasswordSet, notFound, accountLocked } from "./errors.js";

export interface VaultStorage {
  read(): Promise<Record<string, string> | null>; // name -> JSON blob
  write(recs: Record<string, string>): Promise<void>;
}

interface SealedSecret {
  iv: string;
  ciphertext: string;
}

const VERIFY_NAME = "__vault__";
const VERIFY_PLAINTEXT = "lez-wallet-v1-verify";
const SALT_NAME = "__salt__";
const DEFAULT_ITERATIONS = 210_000;

export class PasswordVault {
  private cachedKey: CryptoKey | null = null;
  private readonly iterations: number;

  constructor(
    private readonly storage: VaultStorage,
    iterations: number = DEFAULT_ITERATIONS,
  ) {
    this.iterations = iterations;
  }

  async isInitialized(): Promise<boolean> {
    const recs = await this.storage.read();
    return !!recs && !!recs[VERIFY_NAME];
  }

  /**
   * Initialize the vault with a password. If the vault already exists,
   * `currentPassword` must verify first (this is the password-change path).
   */
  async setPassword(password: string, currentPassword?: string): Promise<void> {
    if (!password || password.length < 8) {
      throw new WalletError("password must be at least 8 characters", "invalid_input");
    }
    const recs = (await this.storage.read()) ?? {};
    if (recs[VERIFY_NAME]) {
      if (!currentPassword) {
        throw new WalletError("current password required to change it", "invalid_input");
      }
      await this.verifyPassword(currentPassword);
      const oldKey = this.cachedKey!;
      // Keep the original plaintext bytes so re-sealing is lossless.
      const decrypted: Record<string, Uint8Array> = {};
      for (const [name, blob] of Object.entries(recs)) {
        if (name === VERIFY_NAME || name === SALT_NAME) continue;
        decrypted[name] = await this.decryptBlob(oldKey, JSON.parse(blob) as SealedSecret);
      }
      this.cachedKey = null;
      await this.initializeVault(password);
      for (const [name, plaintext] of Object.entries(decrypted)) {
        await this.putRaw(name, plaintext);
      }
      return;
    }
    await this.initializeVault(password);
  }

  private async initializeVault(password: string): Promise<void> {
    const salt = randomBytes(16);
    const key = await pbkdf2Key(password, salt, this.iterations);
    const recs = (await this.storage.read()) ?? {};
    const sealed = await aesGcmEncrypt(key, new TextEncoder().encode(VERIFY_PLAINTEXT));
    recs[SALT_NAME] = JSON.stringify({ salt: bytesToHex(salt) });
    recs[VERIFY_NAME] = JSON.stringify({
      iv: bytesToHex(sealed.subarray(0, 12)),
      ciphertext: bytesToHex(sealed.subarray(12)),
    } satisfies SealedSecret);
    await this.storage.write(recs);
    this.cachedKey = key;
  }

  /** Verify the password; throws password_invalid on mismatch. Never wipes. */
  async verifyPassword(password: string): Promise<void> {
    const recs = await this.storage.read();
    if (!recs || !recs[VERIFY_NAME] || !recs[SALT_NAME]) throw passwordInvalid();
    const { salt } = JSON.parse(recs[SALT_NAME]!) as { salt: string };
    const verify = JSON.parse(recs[VERIFY_NAME]!) as SealedSecret;
    const key = await pbkdf2Key(password, hexToBytes(salt), this.iterations);
    try {
      const pt = await this.decryptBlob(key, verify);
      if (!timingSafeEqual(new TextDecoder().decode(pt), VERIFY_PLAINTEXT)) {
        throw new Error("verify mismatch");
      }
      this.cachedKey = key;
    } catch {
      this.cachedKey = null;
      throw passwordInvalid();
    }
  }

  private async decryptBlob(key: CryptoKey, blob: SealedSecret): Promise<Uint8Array> {
    const full = new Uint8Array(12 + hexToBytes(blob.ciphertext).length);
    full.set(hexToBytes(blob.iv), 0);
    full.set(hexToBytes(blob.ciphertext), 12);
    return aesGcmDecrypt(key, full);
  }

  /** Encrypt + persist a named secret. Wallet must be unlocked. */
  async put<T>(name: string, value: T): Promise<void> {
    await this.putRaw(name, new TextEncoder().encode(JSON.stringify(value)));
  }

  /** Encrypt + persist raw plaintext bytes (lossless re-seal path). */
  private async putRaw(name: string, plaintext: Uint8Array): Promise<void> {
    if (!this.cachedKey) throw accountLocked("unlock the wallet to modify secrets");
    const recs = (await this.storage.read()) ?? {};
    const sealed = await aesGcmEncrypt(this.cachedKey, plaintext);
    recs[name] = JSON.stringify({
      iv: bytesToHex(sealed.subarray(0, 12)),
      ciphertext: bytesToHex(sealed.subarray(12)),
    } satisfies SealedSecret);
    await this.storage.write(recs);
  }

  /** Read + decrypt a named secret. Throws not_found if missing. */
  async get<T>(name: string): Promise<T> {
    if (!this.cachedKey) throw accountLocked("unlock the wallet to read secrets");
    const recs = await this.storage.read();
    if (!recs) throw noPasswordSet();
    const blob = recs[name];
    if (!blob) throw notFound(`secret "${name}"`);
    const pt = await this.decryptBlob(this.cachedKey, JSON.parse(blob) as SealedSecret);
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  }

  async list(): Promise<string[]> {
    const recs = await this.storage.read();
    if (!recs) return [];
    return Object.keys(recs).filter((k) => k !== VERIFY_NAME && k !== SALT_NAME);
  }

  async delete(name: string): Promise<void> {
    const recs = (await this.storage.read()) ?? {};
    if (recs[name]) {
      delete recs[name];
      await this.storage.write(recs);
    }
  }

  /** Drop the in-memory key (wallet lock). Persisted state is untouched. */
  lock(): void {
    this.cachedKey = null;
  }

  isUnlocked(): boolean {
    return this.cachedKey !== null;
  }
}