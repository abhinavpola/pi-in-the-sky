import { z } from "zod";

const ENVELOPE_VERSION = 1;

const EncryptedEnvelopeSchema = z.object({
  __enc: z.literal(ENVELOPE_VERSION),
  iv: z.string().min(1),
  ct: z.string().min(1),
});

type VaultMetaRow = {
  id: number;
  wrapped_dek: string;
  salt: string;
};

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function fromBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toUtf8(text: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  const copy = new Uint8Array(buffer);
  copy.set(encoded);
  return copy;
}

async function deriveKek(
  masterSecret: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toUtf8(masterSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: toUtf8("pi-in-the-sky:vault-kek:v1"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  aad: string,
): Promise<{ readonly iv: string; readonly ct: string }> {
  const ivBuffer = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuffer);
  crypto.getRandomValues(iv);
  const cipherBuffer = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: toUtf8(aad),
    },
    key,
    plaintext,
  );
  return {
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(cipherBuffer)),
  };
}

async function aesGcmDecrypt(
  key: CryptoKey,
  ivB64: string,
  ctB64: string,
  aad: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const plainBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(ivB64),
      additionalData: toUtf8(aad),
    },
    key,
    fromBase64(ctB64),
  );
  const buffer = new ArrayBuffer(plainBuffer.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(new Uint8Array(plainBuffer));
  return bytes;
}

export class VaultCipher {
  readonly #sql: SqlStorage;
  readonly #getMasterSecret: () => string | undefined;
  #dekPromise: Promise<CryptoKey> | null = null;

  constructor(sql: SqlStorage, getMasterSecret: () => string | undefined) {
    this.#sql = sql;
    this.#getMasterSecret = getMasterSecret;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS vault_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        wrapped_dek TEXT NOT NULL,
        salt TEXT NOT NULL
      );
    `);
  }

  async #getDek(): Promise<CryptoKey> {
    if (!this.#dekPromise) {
      this.#dekPromise = this.#loadOrCreateDek();
    }
    try {
      return await this.#dekPromise;
    } catch (thrown) {
      this.#dekPromise = null;
      throw thrown;
    }
  }

  async #loadOrCreateDek(): Promise<CryptoKey> {
    const masterSecret = this.#getMasterSecret();
    if (!masterSecret || masterSecret.length < 16) {
      throw new Error(
        "VAULT_MASTER_KEY secret must be configured (at least 16 characters).",
      );
    }

    const existing = this.#sql
      .exec<VaultMetaRow>(
        "SELECT id, wrapped_dek, salt FROM vault_meta WHERE id = 1",
      )
      .toArray()[0];

    if (existing) {
      const kek = await deriveKek(masterSecret, fromBase64(existing.salt));
      const envelope = EncryptedEnvelopeSchema.parse(
        JSON.parse(existing.wrapped_dek),
      );
      const rawDek = await aesGcmDecrypt(
        kek,
        envelope.iv,
        envelope.ct,
        "vault_meta:dek",
      );
      return crypto.subtle.importKey(
        "raw",
        rawDek,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    }

    const saltBuffer = new ArrayBuffer(16);
    const salt = new Uint8Array(saltBuffer);
    crypto.getRandomValues(salt);

    const rawDekBuffer = new ArrayBuffer(32);
    const rawDek = new Uint8Array(rawDekBuffer);
    crypto.getRandomValues(rawDek);

    const kek = await deriveKek(masterSecret, salt);
    const wrapped = await aesGcmEncrypt(kek, rawDek, "vault_meta:dek");
    const wrappedJson = JSON.stringify({
      __enc: ENVELOPE_VERSION,
      iv: wrapped.iv,
      ct: wrapped.ct,
    });

    this.#sql.exec(
      "INSERT OR IGNORE INTO vault_meta (id, wrapped_dek, salt) VALUES (1, ?, ?)",
      wrappedJson,
      toBase64(salt),
    );

    const stored = this.#sql
      .exec<VaultMetaRow>(
        "SELECT id, wrapped_dek, salt FROM vault_meta WHERE id = 1",
      )
      .toArray()[0];
    if (!stored) {
      throw new Error("Failed to persist wrapped Vault DEK.");
    }
    const storedKek = await deriveKek(masterSecret, fromBase64(stored.salt));
    const storedEnv = EncryptedEnvelopeSchema.parse(
      JSON.parse(stored.wrapped_dek),
    );
    const verifiedDek = await aesGcmDecrypt(
      storedKek,
      storedEnv.iv,
      storedEnv.ct,
      "vault_meta:dek",
    );
    return crypto.subtle.importKey(
      "raw",
      verifiedDek,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async encryptText(plaintext: string, aad: string): Promise<string> {
    const dek = await this.#getDek();
    const encrypted = await aesGcmEncrypt(dek, toUtf8(plaintext), aad);
    return JSON.stringify({
      __enc: ENVELOPE_VERSION,
      iv: encrypted.iv,
      ct: encrypted.ct,
    });
  }

  async decryptText(ciphertextJson: string, aad: string): Promise<string> {
    const dek = await this.#getDek();
    const parsed = EncryptedEnvelopeSchema.parse(JSON.parse(ciphertextJson));
    const plainBytes = await aesGcmDecrypt(dek, parsed.iv, parsed.ct, aad);
    return new TextDecoder().decode(plainBytes);
  }

  encryptJson(value: unknown, aad: string): Promise<string> {
    return this.encryptText(JSON.stringify(value), aad);
  }

  async decryptJson<T>(
    ciphertextJson: string,
    aad: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const plain = await this.decryptText(ciphertextJson, aad);
    return schema.parse(JSON.parse(plain));
  }

  async tryDecryptJsonEnvelope(
    value: string,
    aad: string,
  ): Promise<string | null> {
    if (!value.includes('"__enc"')) {
      return null;
    }
    try {
      const parsed = EncryptedEnvelopeSchema.safeParse(JSON.parse(value));
      if (!parsed.success) {
        return null;
      }
      const dek = await this.#getDek();
      const plainBytes = await aesGcmDecrypt(
        dek,
        parsed.data.iv,
        parsed.data.ct,
        aad,
      );
      return new TextDecoder().decode(plainBytes);
    } catch {
      return null;
    }
  }
}
