import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PeerCollector, findPeer, toPeer } from "../src/discovery.ts";
import type { Peer } from "../src/types.ts";

const announcement = {
  alias: "Nice Orange",
  version: "2.1",
  deviceModel: "Samsung",
  deviceType: "mobile",
  fingerprint: "abc123",
  port: 53317,
  protocol: "https",
  download: true,
};

describe("toPeer", () => {
  it("takes the address from the packet's origin, not the payload", () => {
    const peer = toPeer(announcement, "192.168.1.5");
    assert.strictEqual(peer.host, "192.168.1.5");
    assert.strictEqual(peer.alias, "Nice Orange");
    assert.strictEqual(peer.port, 53317);
    assert.strictEqual(peer.protocol, "https");
  });

  it("defaults a missing port to the protocol default", () => {
    const peer = toPeer({ ...announcement, port: undefined }, "192.168.1.5");
    assert.strictEqual(peer.port, 53317);
  });

  it("treats anything but http as https", () => {
    assert.strictEqual(toPeer({ ...announcement, protocol: undefined }, "h").protocol, "https");
    assert.strictEqual(toPeer({ ...announcement, protocol: "http" }, "h").protocol, "http");
  });
});

describe("PeerCollector", () => {
  it("collects a valid announcement", () => {
    const collector = new PeerCollector("me");
    collector.add(announcement, "192.168.1.5");
    assert.strictEqual(collector.list().length, 1);
  });

  it("ignores our own announcement echoed back", () => {
    const collector = new PeerCollector("abc123");
    collector.add(announcement, "192.168.1.5");
    assert.strictEqual(collector.list().length, 0);
  });

  it("collapses repeated announcements from one device", () => {
    const collector = new PeerCollector("me");
    collector.add(announcement, "192.168.1.5");
    collector.add(announcement, "192.168.1.5");
    collector.add({ ...announcement, alias: "Renamed" }, "192.168.1.5");
    assert.strictEqual(collector.list().length, 1);
    assert.strictEqual(collector.list()[0].alias, "Renamed");
  });

  it("keeps two devices apart even when they share a fingerprint", () => {
    const collector = new PeerCollector("me");
    collector.add(announcement, "192.168.1.5");
    collector.add(announcement, "192.168.1.6");
    assert.strictEqual(collector.list().length, 2);
  });

  it("ignores packets that are not LocalSend announcements", () => {
    const collector = new PeerCollector("me");
    collector.add({ hello: "world" }, "192.168.1.5");
    collector.add(null, "192.168.1.5");
    collector.add("a string", "192.168.1.5");
    collector.add(announcement, "");
    assert.strictEqual(collector.list().length, 0);
  });

  it("sorts by alias so output is stable", () => {
    const collector = new PeerCollector("me");
    collector.add({ ...announcement, alias: "Zed", fingerprint: "z" }, "192.168.1.9");
    collector.add({ ...announcement, alias: "Alpha", fingerprint: "a" }, "192.168.1.2");
    assert.deepStrictEqual(collector.list().map((p) => p.alias), ["Alpha", "Zed"]);
  });
});

describe("findPeer", () => {
  const peers: Peer[] = [
    { alias: "Pats iPhone", host: "192.168.1.5", port: 53317, protocol: "https", fingerprint: "aaa" },
    { alias: "Work Laptop", host: "192.168.1.9", port: 53317, protocol: "http", fingerprint: "bbb" },
  ];

  it("matches an exact alias regardless of case", () => {
    assert.strictEqual(findPeer(peers, "pats iphone")?.host, "192.168.1.5");
  });

  it("matches a fingerprint", () => {
    assert.strictEqual(findPeer(peers, "bbb")?.alias, "Work Laptop");
  });

  it("matches a host address", () => {
    assert.strictEqual(findPeer(peers, "192.168.1.9")?.alias, "Work Laptop");
  });

  it("falls back to a partial alias match", () => {
    assert.strictEqual(findPeer(peers, "laptop")?.alias, "Work Laptop");
  });

  it("prefers an exact match over a partial one", () => {
    const tricky: Peer[] = [
      { ...peers[0], alias: "Phone Backup" },
      { ...peers[1], alias: "Phone" },
    ];
    assert.strictEqual(findPeer(tricky, "Phone")?.alias, "Phone");
  });

  it("returns undefined when nothing matches", () => {
    assert.strictEqual(findPeer(peers, "nothing here"), undefined);
  });
});
