import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getStorageDir } from "../storage/storage-paths.ts";

const PREFIX = "enc:v1:";

/**
 * Encrypts provider credentials with AES-256-GCM.
 *
 * Production should set MODEL_PROXY_CREDENTIAL_ENCRYPTION_KEY. For local and
 * single-node installs, a random 256-bit key is generated once beside the
 * operational database with mode 0600.
 */
export function sealCredential(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const key = credentialKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

export function openCredential(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // Backward compatibility for credentials written before migration v7.
  if (!value.startsWith(PREFIX)) return value;
  const packed = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (packed.length < 29) throw new Error("Stored credential ciphertext is malformed");
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", credentialKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function credentialKey(): Buffer {
  const configured = process.env["MODEL_PROXY_CREDENTIAL_ENCRYPTION_KEY"]?.trim();
  if (configured !== undefined && configured.length > 0) {
    return normalizeKey(configured);
  }

  const path = join(getStorageDir("operational"), ".credential-key");
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString("base64url"), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
  return normalizeKey(readFileSync(path, "utf8").trim());
}

function normalizeKey(value: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall through to passphrase derivation.
  }
  return createHash("sha256").update(value, "utf8").digest();
}
