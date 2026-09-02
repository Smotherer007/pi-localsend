/**
 * The wire format of what we send.
 *
 * LocalSend parses the prepare-upload body with a strict deserialiser: a
 * field that is required by the protocol and missing from the JSON is
 * rejected outright as an invalid body, not defaulted. Optional properties
 * in TypeScript serialise away silently, so the contract is asserted on the
 * JSON that actually goes over the wire rather than on the object.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildFileDescriptors, buildSenderInfo } from "../src/clients/send-client.ts";
import { DEFAULT_PORT, type LocalSendConfig, type Peer } from "../src/types.ts";

const REQUIRED_INFO_FIELDS = [
  "alias",
  "version",
  "deviceModel",
  "deviceType",
  "fingerprint",
  "port",
  "protocol",
];

const config: LocalSendConfig = {
  alias: "pi on host",
  deviceModel: "Test Runner",
  deviceType: "desktop",
  downloadDir: "/tmp",
  // 0 means "pick a free port per transfer" locally, and is meaningless to a peer.
  port: 0,
  protocol: "http",
  requirePin: true,
  fingerprint: "random-http-fingerprint",
};

const httpsPeer: Peer = {
  alias: "iPhone",
  host: "192.168.1.5",
  port: DEFAULT_PORT,
  protocol: "https",
  fingerprint: "peer-fp",
};

const httpPeer: Peer = { ...httpsPeer, protocol: "http" };

/** What the peer actually receives, after JSON drops undefined values. */
function overTheWire(info: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(info));
}

describe("prepare-upload info object", () => {
  it("serialises every field the protocol requires", () => {
    const wire = overTheWire(buildSenderInfo(config, httpsPeer, null));
    for (const field of REQUIRED_INFO_FIELDS) {
      assert.ok(field in wire, `"${field}" is missing from the body`);
      assert.notStrictEqual(wire[field], undefined, `"${field}" serialised to undefined`);
    }
  });

  it("sends a real port even though the local setting is 0", () => {
    const wire = overTheWire(buildSenderInfo(config, httpsPeer, null));
    assert.strictEqual(typeof wire.port, "number");
    assert.ok((wire.port as number) > 0, "port 0 tells the peer nothing and breaks parsing");
    assert.strictEqual(wire.port, DEFAULT_PORT);
  });

  it("keeps an explicitly configured port", () => {
    const wire = overTheWire(buildSenderInfo({ ...config, port: 12345 }, httpsPeer, null));
    assert.strictEqual(wire.port, 12345);
  });

  it("reports the protocol of the connection it is speaking on", () => {
    assert.strictEqual(overTheWire(buildSenderInfo(config, httpsPeer, null)).protocol, "https");
    assert.strictEqual(overTheWire(buildSenderInfo(config, httpPeer, null)).protocol, "http");
  });

  it("reports the certificate fingerprint when a certificate is presented", () => {
    const tls = { cert: "", key: "", fingerprint: "certificate-hash" };
    const wire = overTheWire(buildSenderInfo(config, httpsPeer, tls));
    assert.strictEqual(wire.fingerprint, "certificate-hash");
    assert.notStrictEqual(wire.fingerprint, config.fingerprint);
  });

  it("falls back to the stable random id without a certificate", () => {
    const wire = overTheWire(buildSenderInfo(config, httpPeer, null));
    assert.strictEqual(wire.fingerprint, config.fingerprint);
  });

  it("never sends an empty alias or device model", () => {
    const wire = overTheWire(
      buildSenderInfo({ ...config, alias: "", deviceModel: "" }, httpsPeer, null),
    );
    assert.ok((wire.alias as string).length > 0);
    assert.ok((wire.deviceModel as string).length > 0);
  });
});

describe("prepare-upload file descriptors", () => {
  it("serialises every field the protocol requires per file", () => {
    const { files } = buildFileDescriptors([
      { fileName: "report.pdf", content: Buffer.from("x"), size: 1 },
    ]);
    const wire = overTheWire(files) as Record<string, Record<string, unknown>>;
    const descriptor = Object.values(wire)[0];

    for (const field of ["id", "fileName", "size", "fileType"]) {
      assert.ok(field in descriptor, `"${field}" is missing`);
    }
    assert.strictEqual(typeof descriptor.size, "number");
    assert.strictEqual(descriptor.fileType, "application/pdf");
  });

  it("keys each descriptor by the id it carries", () => {
    const { files } = buildFileDescriptors([
      { fileName: "a.txt", content: Buffer.from("a"), size: 1 },
      { fileName: "b.txt", content: Buffer.from("b"), size: 1 },
    ]);
    for (const [key, descriptor] of Object.entries(files)) {
      assert.strictEqual(key, descriptor.id);
    }
  });

  it("omits optional fields rather than sending nulls", () => {
    const { files } = buildFileDescriptors([
      { fileName: "a.txt", content: Buffer.from("a"), size: 1 },
    ]);
    const descriptor = Object.values(overTheWire(files) as any)[0] as Record<string, unknown>;
    assert.ok(!("sha256" in descriptor));
    assert.ok(!("preview" in descriptor));
    assert.ok(!("metadata" in descriptor));
  });

  it("includes the modified timestamp when one is known", () => {
    const { files } = buildFileDescriptors([
      { fileName: "a.txt", path: "/tmp/a.txt", size: 1, modified: "2026-01-01T00:00:00.000Z" },
    ]);
    const descriptor = Object.values(overTheWire(files) as any)[0] as any;
    assert.strictEqual(descriptor.metadata.modified, "2026-01-01T00:00:00.000Z");
  });
});
