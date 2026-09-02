/**
 * A minimal X.509 certificate generator.
 *
 * LocalSend requires the sender to present a TLS client certificate, so a
 * certificate is not optional -- and shelling out to `openssl` would make the
 * extension depend on a binary that is routinely absent on Windows. Node can
 * generate the key pair and produce the signature; what it cannot do is
 * assemble a certificate, so the DER is built here.
 *
 * Only what a self-signed LocalSend identity needs is implemented: RSA-2048,
 * SHA-256, and the four extensions a peer's verifier checks.
 */

import * as crypto from "node:crypto";

// --- DER primitives -------------------------------------------------------

/** Encode a length in DER's short or long form. */
function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);

  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tagged(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function sequence(...parts: Buffer[]): Buffer {
  return tagged(0x30, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
  return tagged(0x31, Buffer.concat(parts));
}

function integer(value: Buffer | number): Buffer {
  if (typeof value === "number") {
    const bytes: number[] = [];
    let remaining = value;
    do {
      bytes.unshift(remaining & 0xff);
      remaining >>>= 8;
    } while (remaining > 0);
    if (bytes[0] & 0x80) bytes.unshift(0x00);
    return tagged(0x02, Buffer.from(bytes));
  }

  // A leading 1 bit would make the integer negative, so pad it.
  const padded = value[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), value]) : value;
  return tagged(0x02, padded);
}

function bitString(content: Buffer, unusedBits = 0): Buffer {
  return tagged(0x03, Buffer.concat([Buffer.from([unusedBits]), content]));
}

function octetString(content: Buffer): Buffer {
  return tagged(0x04, content);
}

const NULL_VALUE = Buffer.from([0x05, 0x00]);

/** Encode a dotted OID: the first two arcs share a byte, the rest are base-128. */
function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const bytes: number[] = [40 * arcs[0] + arcs[1]];

  for (const arc of arcs.slice(2)) {
    if (arc < 0x80) {
      bytes.push(arc);
      continue;
    }
    const chunk: number[] = [];
    let remaining = arc;
    while (remaining > 0) {
      chunk.unshift((remaining & 0x7f) | (chunk.length ? 0x80 : 0));
      remaining >>>= 7;
    }
    bytes.push(...chunk);
  }
  return tagged(0x06, Buffer.from(bytes));
}

function utf8String(value: string): Buffer {
  return tagged(0x0c, Buffer.from(value, "utf-8"));
}

function ia5String(value: string): Buffer {
  return tagged(0x16, Buffer.from(value, "ascii"));
}

/** UTCTime as YYMMDDHHMMSSZ, which is valid until 2049. */
function utcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return tagged(0x17, Buffer.from(text, "ascii"));
}

/** A context-specific constructed tag, e.g. [0] EXPLICIT. */
function explicit(tagNumber: number, content: Buffer): Buffer {
  return tagged(0xa0 | tagNumber, content);
}

/** A context-specific primitive tag, e.g. [2] IMPLICIT in a GeneralName. */
function implicitPrimitive(tagNumber: number, content: Buffer): Buffer {
  return tagged(0x80 | tagNumber, content);
}

const BOOLEAN_TRUE = Buffer.from([0x01, 0x01, 0xff]);

// --- Certificate structure ------------------------------------------------

const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
const OID_COMMON_NAME = "2.5.4.3";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const OID_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

const SIGNATURE_ALGORITHM = sequence(oid(OID_SHA256_RSA), NULL_VALUE);

function distinguishedName(commonName: string): Buffer {
  return sequence(set(sequence(oid(OID_COMMON_NAME), utf8String(commonName))));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(
    oid(id),
    ...(critical ? [BOOLEAN_TRUE] : []),
    octetString(value),
  );
}

/**
 * The extensions a peer's certificate verifier requires.
 *
 * A webpki-based verifier -- rustls, which LocalSend's core uses -- rejects a
 * certificate that is marked as a CA, carries no subjectAltName, or does not
 * list clientAuth, answering with a "certificate unknown" alert during the
 * handshake. openssl's bare defaults produce a certificate that fails all
 * three, which is why they are spelled out rather than left off.
 */
function extensions(dnsNames: string[], ipAddresses: string[]): Buffer {
  // An empty SEQUENCE means cA is absent, i.e. FALSE: an end entity.
  const basicConstraints = extension(OID_BASIC_CONSTRAINTS, true, sequence());

  // digitalSignature (bit 0) and keyEncipherment (bit 2) -> 0b10100000,
  // with the low five bits unused.
  const keyUsage = extension(
    OID_KEY_USAGE,
    true,
    bitString(Buffer.from([0xa0]), 5),
  );

  const extendedKeyUsage = extension(
    OID_EXT_KEY_USAGE,
    false,
    sequence(oid(OID_CLIENT_AUTH), oid(OID_SERVER_AUTH)),
  );

  const names: Buffer[] = [
    // dNSName is [2] IMPLICIT IA5String.
    ...dnsNames.map((name) => implicitPrimitive(2, Buffer.from(name, "ascii"))),
    // iPAddress is [7] IMPLICIT OCTET STRING of four bytes for IPv4.
    ...ipAddresses.map((address) =>
      implicitPrimitive(7, Buffer.from(address.split(".").map(Number))),
    ),
  ];
  const subjectAltName = extension(OID_SUBJECT_ALT_NAME, false, sequence(...names));

  return sequence(basicConstraints, keyUsage, extendedKeyUsage, subjectAltName);
}

function toPem(der: Buffer, label: string): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export interface CertificateOptions {
  readonly commonName?: string;
  readonly dnsNames?: string[];
  readonly ipAddresses?: string[];
  /**
   * Apple platforms reject TLS server certificates with a lifetime longer
   * than 398 days, so the default stays comfortably below that.
   */
  readonly validityDays?: number;
}

export interface GeneratedCertificate {
  readonly cert: string;
  readonly key: string;
}

/**
 * Generate a self-signed certificate and its private key, both PEM encoded.
 *
 * Works anywhere Node runs -- no external binary, so Windows and Linux behave
 * exactly like macOS.
 */
export function generateSelfSignedCertificate(
  options: CertificateOptions = {},
): GeneratedCertificate {
  const commonName = options.commonName ?? "LocalSend";
  const dnsNames = options.dnsNames ?? ["localsend", "localhost"];
  const ipAddresses = options.ipAddresses ?? ["127.0.0.1"];
  const validityDays = options.validityDays ?? 365;

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  // Node hands us the SubjectPublicKeyInfo already DER encoded, so the one
  // genuinely fiddly structure does not have to be built by hand.
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;

  const notBefore = new Date(Date.now() - 60_000); // tolerate small clock skew
  const notAfter = new Date(notBefore.getTime() + validityDays * 86_400_000);

  const tbsCertificate = sequence(
    explicit(0, integer(2)), // version v3
    integer(crypto.randomBytes(16)),
    SIGNATURE_ALGORITHM,
    distinguishedName(commonName), // issuer, same as subject when self-signed
    sequence(utcTime(notBefore), utcTime(notAfter)),
    distinguishedName(commonName),
    spki,
    explicit(3, extensions(dnsNames, ipAddresses)),
  );

  const signature = crypto.sign("sha256", tbsCertificate, privateKey);
  const certificate = sequence(tbsCertificate, SIGNATURE_ALGORITHM, bitString(signature));

  return {
    cert: toPem(certificate, "CERTIFICATE"),
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}
