import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  API_PREFIX,
  DEFAULT_PORT,
  LocalSendNotConfiguredError,
  MULTICAST_ADDRESS,
  PROTOCOL_VERSION,
  PeerNotFoundError,
  TransferRejectedError,
  UnsafeFileNameError,
} from "../src/types.ts";

describe("Protocol constants", () => {
  it("matches the LocalSend v2 specification", () => {
    assert.strictEqual(MULTICAST_ADDRESS, "224.0.0.167");
    assert.strictEqual(DEFAULT_PORT, 53317);
    assert.strictEqual(API_PREFIX, "/api/localsend/v2");
    assert.strictEqual(PROTOCOL_VERSION, "2.1");
  });
});

describe("Error types", () => {
  it("PeerNotFoundError explains how to look again", () => {
    const err = new PeerNotFoundError("Phone");
    assert.match(err.message, /"Phone"/);
    assert.match(err.message, /localsend_devices/);
  });

  it("TransferRejectedError keeps the status", () => {
    const err = new TransferRejectedError(409, "busy");
    assert.strictEqual(err.status, 409);
    assert.strictEqual(err.name, "TransferRejectedError");
  });

  it("UnsafeFileNameError names the offending file", () => {
    assert.match(new UnsafeFileNameError("../x").message, /\.\.\/x/);
  });

  it("LocalSendNotConfiguredError points at setup", () => {
    assert.match(new LocalSendNotConfiguredError().message, /localsend_setup/);
  });
});
