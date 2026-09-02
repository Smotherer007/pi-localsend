import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatListening,
  formatPeerList,
  formatReceiveResult,
  formatSendResult,
  formatStatus,
} from "../src/formatting/formatters.ts";
import type { LocalSendConfig, Peer } from "../src/types.ts";

const peer: Peer = {
  alias: "Pats iPhone",
  host: "192.168.1.5",
  port: 53317,
  protocol: "https",
  fingerprint: "abc",
  deviceModel: "iPhone 15",
  deviceType: "mobile",
};

const config: LocalSendConfig = {
  alias: "pi on mbp",
  deviceModel: "Darwin 24",
  deviceType: "desktop",
  downloadDir: "/Users/pat/Downloads",
  protocol: "http",
  port: 0,
  requirePin: true,
  fingerprint: "a".repeat(64),
};

describe("formatPeerList", () => {
  it("gives actionable advice when nothing answered", () => {
    const text = formatPeerList([]);
    assert.match(text, /No LocalSend devices answered/);
    assert.match(text, /same network/);
    assert.match(text, /guest network/);
    assert.match(text, /localsend_send accepts host and port/);
  });

  it("lists devices with their address and how to send", () => {
    const text = formatPeerList([peer]);
    assert.match(text, /Pats iPhone \(mobile\) -- iPhone 15/);
    assert.match(text, /https:\/\/192\.168\.1\.5:53317/);
    assert.match(text, /localsend_send/);
  });

  it("appends warnings as notes", () => {
    const text = formatPeerList([peer], ["port busy"]);
    assert.match(text, /Notes:/);
    assert.match(text, /- port busy/);
  });
});

describe("formatSendResult", () => {
  it("reports a clean send", () => {
    const text = formatSendResult({
      peer,
      sessionId: "s1",
      bytesSent: 2048,
      files: [{ fileName: "a.pdf", size: 2048, ok: true }],
    });
    assert.match(text, /Sent 1 file\(s\) to Pats iPhone \(2\.0 KB\)/);
    assert.match(text, /- a\.pdf/);
    assert.ok(!/Failed:/.test(text));
  });

  it("separates failures from successes", () => {
    const text = formatSendResult({
      peer,
      sessionId: "s1",
      bytesSent: 10,
      files: [
        { fileName: "a.txt", size: 10, ok: true },
        { fileName: "b.txt", size: 5, ok: false, error: "HTTP 500" },
      ],
    });
    assert.match(text, /Sent 1 of 2 file\(s\)/);
    assert.match(text, /Failed:/);
    assert.match(text, /b\.txt: HTTP 500/);
  });

  it("explains a receiver that wanted nothing", () => {
    const text = formatSendResult({ peer, sessionId: "", bytesSent: 0, files: [] });
    assert.match(text, /wanted none of the files/);
  });
});

describe("formatReceiveResult", () => {
  it("says the receiver shut down after a timeout", () => {
    const text = formatReceiveResult(
      { files: [], bytesReceived: 0, outcome: "timeout" },
      "/tmp/in",
    );
    assert.match(text, /No transfer arrived/);
    assert.match(text, /shut down/);
  });

  it("lists the files and where they went", () => {
    const text = formatReceiveResult(
      {
        files: [{ fileName: "a.pdf", path: "/tmp/in/a.pdf", size: 1024 }],
        sender: { alias: "Pats iPhone", version: "2.1", fingerprint: "x" },
        senderAddress: "192.168.1.5",
        bytesReceived: 1024,
        outcome: "completed",
      },
      "/tmp/in",
    );
    assert.match(text, /Received 1 file\(s\) from Pats iPhone \(192\.168\.1\.5\)/);
    assert.match(text, /\/tmp\/in\/a\.pdf \(1\.0 KB\)/);
  });

  it("flags a partial transfer that was cancelled", () => {
    const text = formatReceiveResult(
      {
        files: [{ fileName: "a.pdf", path: "/tmp/in/a.pdf", size: 10 }],
        bytesReceived: 10,
        outcome: "cancelled",
      },
      "/tmp/in",
    );
    assert.match(text, /cancelled partway through/);
  });

  it("handles a cancelled transfer with no files", () => {
    const text = formatReceiveResult(
      { files: [], bytesReceived: 0, outcome: "cancelled" },
      "/tmp/in",
    );
    assert.match(text, /cancelled before any file arrived/);
  });
});

describe("formatListening", () => {
  it("shows the PIN and the reachable addresses", () => {
    const text = formatListening(
      { port: 41234, protocol: "http", addresses: ["192.168.1.10"] },
      "654321",
      300,
    );
    assert.match(text, /up to 300s/);
    assert.match(text, /http port 41234/);
    assert.match(text, /192\.168\.1\.10:41234/);
    assert.match(text, /PIN: 654321/);
  });

  it("warns plainly when running without a PIN", () => {
    const text = formatListening({ port: 1, protocol: "http", addresses: [] }, null, 60);
    assert.match(text, /any device on this network can send/);
  });
});

describe("formatStatus", () => {
  it("summarises the settings and states that nothing is listening", () => {
    const text = formatStatus(config, ["192.168.1.10"], false, true);
    assert.match(text, /Alias: pi on mbp/);
    assert.match(text, /a free port is picked per transfer/);
    assert.match(text, /PIN for incoming transfers: required/);
    assert.match(text, /Using defaults/);
    assert.match(text, /Nothing is listening right now/);
  });

  it("warns when https is configured but unavailable", () => {
    const text = formatStatus({ ...config, protocol: "https" }, [], false, false);
    assert.match(text, /no certificate available/);
    assert.match(text, /No non-local network interface/);
  });

  it("does not leak the whole fingerprint", () => {
    const text = formatStatus(config, [], true, true);
    assert.ok(!text.includes(config.fingerprint));
    assert.match(text, /Fingerprint: a{16}\.\.\./);
  });
});
