/**
 * Certificate generation.
 *
 * The properties asserted here are the ones a peer's verifier checks during
 * the handshake. LocalSend's core validates the certificate a sender
 * presents, and a webpki-based verifier (rustls) rejects a certificate that
 * is a CA, has no subjectAltName, or lacks clientAuth -- answering with a
 * "certificate unknown" alert before any HTTP is exchanged. None of that is
 * observable from a loopback test against our own receiver, which does not
 * verify client certificates, so it is asserted on the certificate itself.
 *
 * Nothing here shells out, so the suite behaves identically on Windows,
 * Linux and macOS.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, createPrivateKey } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  certificateFingerprint,
  ensureTlsMaterial,
  isEncryptionAvailable,
  isUsableCertificate,
} from "../src/tls.ts";
import { generateSelfSignedCertificate } from "../src/x509.ts";
import { LEGACY_CA_CERTIFICATE } from "./fixtures.ts";

describe("generateSelfSignedCertificate", () => {
  const generated = generateSelfSignedCertificate();
  const parsed = new X509Certificate(generated.cert);

  it("produces a certificate Node can parse", () => {
    assert.strictEqual(parsed.subject, "CN=LocalSend");
    assert.strictEqual(parsed.issuer, "CN=LocalSend");
  });

  it("is self-signed with a verifiable signature", () => {
    assert.strictEqual(parsed.verify(parsed.publicKey), true);
  });

  it("emits a usable private key", () => {
    assert.ok(createPrivateKey(generated.key));
    assert.match(generated.key, /^-----BEGIN PRIVATE KEY-----/);
  });

  it("is an end entity, not a CA", () => {
    assert.strictEqual(parsed.ca, false);
  });

  it("carries a subjectAltName", () => {
    assert.ok(parsed.subjectAltName, "no SAN: webpki rejects such certificates");
    assert.match(parsed.subjectAltName!, /DNS:localsend/);
    assert.match(parsed.subjectAltName!, /IP Address:127\.0\.0\.1/);
  });

  it("lists clientAuth so it can be presented as a client certificate", () => {
    assert.ok(parsed.keyUsage?.includes("1.3.6.1.5.5.7.3.2"), "clientAuth missing");
    assert.ok(parsed.keyUsage?.includes("1.3.6.1.5.5.7.3.1"), "serverAuth missing");
  });

  it("stays within the 398 day limit Apple platforms enforce", () => {
    const days = (Date.parse(parsed.validTo) - Date.parse(parsed.validFrom)) / 86_400_000;
    assert.ok(days > 0 && days <= 398, `valid for ${Math.round(days)} days`);
  });

  it("backdates slightly so a small clock difference does not invalidate it", () => {
    assert.ok(Date.parse(parsed.validFrom) <= Date.now());
  });

  it("gives every certificate its own serial number", () => {
    const other = new X509Certificate(generateSelfSignedCertificate().cert);
    assert.notStrictEqual(parsed.serialNumber, other.serialNumber);
  });

  it("honours a custom validity, name and addresses", () => {
    const custom = new X509Certificate(
      generateSelfSignedCertificate({
        commonName: "Test Device",
        dnsNames: ["example.internal"],
        ipAddresses: ["10.1.2.3"],
        validityDays: 30,
      }).cert,
    );
    assert.strictEqual(custom.subject, "CN=Test Device");
    assert.match(custom.subjectAltName!, /DNS:example\.internal/);
    assert.match(custom.subjectAltName!, /IP Address:10\.1\.2\.3/);
    const days = (Date.parse(custom.validTo) - Date.parse(custom.validFrom)) / 86_400_000;
    assert.ok(Math.abs(days - 30) < 1);
  });
});

describe("isUsableCertificate", () => {
  it("accepts a freshly generated certificate", () => {
    assert.strictEqual(isUsableCertificate(generateSelfSignedCertificate().cert), true);
  });

  it("rejects the CA-without-SAN certificate earlier versions generated", () => {
    const parsed = new X509Certificate(LEGACY_CA_CERTIFICATE);
    // Confirm the fixture really is the shape that fails against a peer.
    assert.strictEqual(parsed.ca, true);
    assert.strictEqual(parsed.subjectAltName, undefined);
    assert.strictEqual(isUsableCertificate(LEGACY_CA_CERTIFICATE), false);
  });

  it("rejects a certificate that is about to expire", () => {
    const expiring = generateSelfSignedCertificate({ validityDays: 1 });
    assert.strictEqual(isUsableCertificate(expiring.cert), false);
  });

  it("rejects anything that is not a certificate", () => {
    assert.strictEqual(isUsableCertificate("not a certificate"), false);
    assert.strictEqual(isUsableCertificate(""), false);
  });
});

describe("ensureTlsMaterial", () => {
  const originalHome = process.env.HOME;
  let sandbox: string;

  before(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ls-tls-"));
    process.env.HOME = sandbox;
  });

  after(() => {
    process.env.HOME = originalHome;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("needs nothing installed on the host", () => {
    assert.strictEqual(isEncryptionAvailable(), true);
  });

  it("keeps the same certificate across calls", () => {
    assert.strictEqual(ensureTlsMaterial()!.fingerprint, ensureTlsMaterial()!.fingerprint);
  });

  it("writes the private key so only the owner can read it", () => {
    ensureTlsMaterial();
    const keyPath = path.join(sandbox, ".pi", "localsend", "key.pem");
    assert.strictEqual(fs.statSync(keyPath).mode & 0o777, 0o600);
  });

  it("reports the SHA-256 of the certificate as the fingerprint", () => {
    const material = ensureTlsMaterial()!;
    assert.strictEqual(material.fingerprint, certificateFingerprint(material.cert));
    assert.match(material.fingerprint, /^[0-9a-f]{64}$/);
  });

  it("replaces a stored certificate a peer would reject", () => {
    const dir = path.join(sandbox, ".pi", "localsend");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cert.pem"), LEGACY_CA_CERTIFICATE);
    fs.writeFileSync(path.join(dir, "key.pem"), "not a key");

    const material = ensureTlsMaterial();
    assert.ok(material);
    assert.notStrictEqual(material!.fingerprint, certificateFingerprint(LEGACY_CA_CERTIFICATE));
    assert.strictEqual(isUsableCertificate(material!.cert), true);
    assert.strictEqual(new X509Certificate(material!.cert).ca, false);
  });
});
