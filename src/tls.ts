/**
 * Optional TLS support.
 *
 * LocalSend normally runs over HTTPS with a self-signed certificate, and the
 * device fingerprint is then the SHA-256 of that certificate. Node cannot
 * generate certificates on its own, and pulling in a crypto library for one
 * optional feature is not worth it, so this shells out to openssl when it is
 * available and cleanly reports that HTTPS is unavailable when it is not.
 * The protocol supports plain HTTP, which is the fallback.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TlsMaterial {
  readonly cert: string;
  readonly key: string;
  /** SHA-256 of the DER-encoded certificate, lowercase hex. */
  readonly fingerprint: string;
}

function certDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".pi", "localsend");
}

export function isOpensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** SHA-256 over the certificate's DER bytes, which is what peers compare. */
export function certificateFingerprint(certPem: string): string {
  const der = new crypto.X509Certificate(certPem).raw;
  return crypto.createHash("sha256").update(der).digest("hex");
}

/**
 * Return the cached self-signed certificate, generating one on first use.
 * Returns null when openssl is unavailable, so the caller can fall back to
 * plain HTTP instead of failing the transfer.
 */
export function ensureTlsMaterial(): TlsMaterial | null {
  const dir = certDir();
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");

  try {
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const cert = fs.readFileSync(certPath, "utf-8");
      const key = fs.readFileSync(keyPath, "utf-8");
      return { cert, key, fingerprint: certificateFingerprint(cert) };
    }
  } catch {
    // A corrupt or unreadable pair is regenerated below.
  }

  if (!isOpensslAvailable()) return null;

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "3650",
        "-nodes",
        "-subj",
        "/CN=LocalSend",
      ],
      { stdio: "ignore", timeout: 60_000 },
    );
    fs.chmodSync(keyPath, 0o600);

    const cert = fs.readFileSync(certPath, "utf-8");
    const key = fs.readFileSync(keyPath, "utf-8");
    return { cert, key, fingerprint: certificateFingerprint(cert) };
  } catch {
    return null;
  }
}
