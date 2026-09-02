/**
 * The device's TLS identity.
 *
 * LocalSend runs over HTTPS with a self-signed certificate, and the device
 * fingerprint is the SHA-256 of that certificate. The certificate is
 * generated in process (see x509.ts) rather than by shelling out to openssl,
 * because a sender must present a client certificate for any transfer to a
 * LocalSend app to work at all -- depending on a binary that is routinely
 * missing on Windows would make the extension unusable there.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateSelfSignedCertificate } from "./x509.ts";

/**
 * Apple platforms reject TLS server certificates with a lifetime longer than
 * 398 days, so a long-lived certificate is refused outright by an iPhone.
 */
const VALIDITY_DAYS = 365;

/** Regenerate before it expires rather than failing a transfer mid-week. */
const RENEW_BEFORE_MS = 14 * 24 * 60 * 60 * 1000;


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

/**
 * Can this machine present a TLS identity at all? True everywhere Node can
 * write to the config directory, which is why it no longer depends on what
 * happens to be installed on the host.
 */
export function isEncryptionAvailable(): boolean {
  return ensureTlsMaterial() !== null;
}

/** SHA-256 over the certificate's DER bytes, which is what peers compare. */
export function certificateFingerprint(certPem: string): string {
  const der = new crypto.X509Certificate(certPem).raw;
  return crypto.createHash("sha256").update(der).digest("hex");
}

/**
 * Is this certificate one a peer will actually accept?
 *
 * Earlier versions of this extension generated a CA certificate with no
 * subjectAltName, which LocalSend rejects during the handshake. Checking the
 * stored certificate rather than only its presence means an installation
 * that has one of those repairs itself on the next transfer.
 */
export function isUsableCertificate(certPem: string): boolean {
  try {
    const parsed = new crypto.X509Certificate(certPem);

    if (parsed.ca) return false;
    if (!parsed.subjectAltName) return false;

    const expiry = Date.parse(parsed.validTo);
    if (Number.isNaN(expiry) || expiry - Date.now() < RENEW_BEFORE_MS) return false;

    // Node exposes the extended key usage OIDs as keyUsage.
    // 1.3.6.1.5.5.7.3.2 is clientAuth.
    const usage = parsed.keyUsage ?? [];
    if (usage.length > 0 && !usage.includes("1.3.6.1.5.5.7.3.2")) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Return the cached certificate, generating one on first use and replacing
 * one a peer would reject. Returns null only if the config directory cannot
 * be written, so the caller can explain itself instead of failing with a TLS
 * error.
 */
export function ensureTlsMaterial(): TlsMaterial | null {
  const dir = certDir();
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");

  try {
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const cert = fs.readFileSync(certPath, "utf-8");
      const key = fs.readFileSync(keyPath, "utf-8");
      if (isUsableCertificate(cert)) {
        return { cert, key, fingerprint: certificateFingerprint(cert) };
      }
      // Falls through to regeneration below.
    }
  } catch {
    // A corrupt or unreadable pair is regenerated below.
  }

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const generated = generateSelfSignedCertificate({ validityDays: VALIDITY_DAYS });
    fs.writeFileSync(keyPath, generated.key, { encoding: "utf-8", mode: 0o600 });
    fs.writeFileSync(certPath, generated.cert, { encoding: "utf-8", mode: 0o644 });
    fs.chmodSync(keyPath, 0o600);

    return {
      cert: generated.cert,
      key: generated.key,
      fingerprint: certificateFingerprint(generated.cert),
    };
  } catch {
    // Only an unwritable config directory gets here.
    return null;
  }
}
