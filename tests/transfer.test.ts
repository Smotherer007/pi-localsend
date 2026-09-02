/**
 * End-to-end transfer tests.
 *
 * These run the real receiver and the real send client against each other
 * over loopback, so the protocol handling, the session/token checks and the
 * on-disk result are all exercised for real rather than mocked.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { receiveOnce } from "../src/server/receive-server.ts";
import { sendFiles } from "../src/clients/send-client.ts";
import { API_PREFIX, type LocalSendConfig, type Peer } from "../src/types.ts";

function makeConfig(downloadDir: string, overrides: Partial<LocalSendConfig> = {}): LocalSendConfig {
  return {
    alias: "pi test",
    deviceModel: "test runner",
    deviceType: "headless",
    downloadDir,
    protocol: "http",
    port: 0,
    requirePin: true,
    fingerprint: "test-fingerprint",
    ...overrides,
  };
}

function peerAt(port: number, protocol: "http" | "https" = "http"): Peer {
  return { alias: "loopback", host: "127.0.0.1", port, protocol, fingerprint: "peer" };
}

/** Open a session without uploading, to occupy the receiver. */
function openDanglingSession(port: number): Promise<number> {
  const body = JSON.stringify({
    info: { alias: "other", version: "2.1", fingerprint: "other" },
    files: { f1: { id: "f1", fileName: "big.bin", size: 999999, fileType: "application/octet-stream" } },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `${API_PREFIX}/prepare-upload`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("loopback transfer", () => {
  let downloadDir: string;
  let sourceDir: string;

  beforeEach(() => {
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-in-"));
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-out-"));
  });

  afterEach(() => {
    fs.rmSync(downloadDir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  it("transfers a file from disk and an in-memory text payload", async () => {
    const config = makeConfig(downloadDir);
    const filePath = path.join(sourceDir, "hello.txt");
    fs.writeFileSync(filePath, "hello localsend");

    const handle = await receiveOnce(config, {
      downloadDir,
      pin: "123456",
      timeoutMs: 10_000,
    });

    const result = await sendFiles(config, {
      peer: peerAt(handle.port),
      pin: "123456",
      payloads: [
        { fileName: "hello.txt", path: filePath, size: 15 },
        { fileName: "note.txt", content: Buffer.from("inline text"), size: 11 },
      ],
    });

    assert.strictEqual(result.files.every((file) => file.ok), true);
    assert.strictEqual(result.bytesSent, 26);

    const received = await handle.done;
    assert.strictEqual(received.outcome, "completed");
    assert.strictEqual(received.files.length, 2);
    assert.strictEqual(received.bytesReceived, 26);
    assert.strictEqual(received.sender?.alias, "pi test");

    assert.strictEqual(fs.readFileSync(path.join(downloadDir, "hello.txt"), "utf-8"), "hello localsend");
    assert.strictEqual(fs.readFileSync(path.join(downloadDir, "note.txt"), "utf-8"), "inline text");
  });

  it("rejects a wrong PIN and accepts nothing", async () => {
    const config = makeConfig(downloadDir);
    const handle = await receiveOnce(config, {
      downloadDir,
      pin: "123456",
      timeoutMs: 2000,
    });

    await assert.rejects(
      () =>
        sendFiles(config, {
          peer: peerAt(handle.port),
          pin: "000000",
          payloads: [{ fileName: "x.txt", content: Buffer.from("x"), size: 1 }],
        }),
      (err: any) => {
        assert.strictEqual(err.name, "TransferRejectedError");
        assert.strictEqual(err.status, 401);
        return true;
      },
    );

    const received = await handle.done;
    assert.strictEqual(received.outcome, "timeout");
    assert.deepStrictEqual(fs.readdirSync(downloadDir), []);
  });

  it("accepts without a PIN when none is set", async () => {
    const config = makeConfig(downloadDir, { requirePin: false });
    const handle = await receiveOnce(config, { downloadDir, pin: null, timeoutMs: 10_000 });

    await sendFiles(config, {
      peer: peerAt(handle.port),
      payloads: [{ fileName: "open.txt", content: Buffer.from("no pin"), size: 6 }],
    });

    const received = await handle.done;
    assert.strictEqual(received.outcome, "completed");
    assert.strictEqual(fs.readFileSync(path.join(downloadDir, "open.txt"), "utf-8"), "no pin");
  });

  it("contains a path traversal attempt inside the download directory", async () => {
    const config = makeConfig(downloadDir, { requirePin: false });
    const handle = await receiveOnce(config, { downloadDir, pin: null, timeoutMs: 10_000 });

    await sendFiles(config, {
      peer: peerAt(handle.port),
      payloads: [
        { fileName: "../../../../tmp/pi-localsend-pwned.txt", content: Buffer.from("evil"), size: 4 },
      ],
    });

    const received = await handle.done;
    assert.strictEqual(received.files.length, 1);
    assert.strictEqual(path.dirname(received.files[0].path), downloadDir);
    assert.strictEqual(path.basename(received.files[0].path), "pi-localsend-pwned.txt");
    assert.strictEqual(fs.existsSync("/tmp/pi-localsend-pwned.txt"), false);
  });

  it("does not overwrite when two files share a name", async () => {
    const config = makeConfig(downloadDir, { requirePin: false });
    const handle = await receiveOnce(config, { downloadDir, pin: null, timeoutMs: 10_000 });

    await sendFiles(config, {
      peer: peerAt(handle.port),
      payloads: [
        { fileName: "same.txt", content: Buffer.from("first"), size: 5 },
        { fileName: "same.txt", content: Buffer.from("second"), size: 6 },
      ],
    });

    await handle.done;
    assert.deepStrictEqual(fs.readdirSync(downloadDir).sort(), ["same (2).txt", "same.txt"]);
  });

  it("refuses a second session while one is in progress", async () => {
    const config = makeConfig(downloadDir, { requirePin: false });
    const handle = await receiveOnce(config, { downloadDir, pin: null, timeoutMs: 2000 });

    assert.strictEqual(await openDanglingSession(handle.port), 200);

    await assert.rejects(
      () =>
        sendFiles(config, {
          peer: peerAt(handle.port),
          payloads: [{ fileName: "second.txt", content: Buffer.from("x"), size: 1 }],
        }),
      (err: any) => {
        assert.strictEqual(err.status, 409);
        return true;
      },
    );

    await handle.done;
  });

  it("times out and shuts down when nobody sends", async () => {
    const config = makeConfig(downloadDir);
    const started = Date.now();
    const handle = await receiveOnce(config, { downloadDir, pin: null, timeoutMs: 400 });

    const received = await handle.done;
    assert.strictEqual(received.outcome, "timeout");
    assert.strictEqual(received.files.length, 0);
    assert.ok(Date.now() - started >= 350);

    // The port must be free again once the receiver has shut down.
    await assert.rejects(
      () =>
        sendFiles(config, {
          peer: peerAt(handle.port),
          payloads: [{ fileName: "late.txt", content: Buffer.from("x"), size: 1 }],
        }),
      /refused the connection|not reachable/,
    );
  });

  it("stops when the caller aborts", async () => {
    const config = makeConfig(downloadDir);
    const controller = new AbortController();
    const handle = await receiveOnce(config, {
      downloadDir,
      pin: null,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    controller.abort();
    const received = await handle.done;
    assert.strictEqual(received.outcome, "cancelled");
  });

  it("reports each file as it arrives", async () => {
    const config = makeConfig(downloadDir, { requirePin: false });
    const seen: string[] = [];
    const handle = await receiveOnce(config, {
      downloadDir,
      pin: null,
      timeoutMs: 10_000,
      onFile: (file) => seen.push(file.fileName),
    });

    await sendFiles(config, {
      peer: peerAt(handle.port),
      payloads: [
        { fileName: "one.txt", content: Buffer.from("1"), size: 1 },
        { fileName: "two.txt", content: Buffer.from("2"), size: 1 },
      ],
    });

    await handle.done;
    assert.deepStrictEqual(seen.sort(), ["one.txt", "two.txt"]);
  });

  it("answers the info endpoint with this device's details", async () => {
    const config = makeConfig(downloadDir, { alias: "Introspect" });
    const handle = await receiveOnce(config, { downloadDir, pin: null, timeoutMs: 2000 });

    const info: any = await new Promise((resolve, reject) => {
      http
        .get(
          { host: "127.0.0.1", port: handle.port, path: `${API_PREFIX}/info` },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
          },
        )
        .on("error", reject);
    });

    assert.strictEqual(info.alias, "Introspect");
    assert.strictEqual(info.version, "2.1");
    assert.strictEqual(info.port, handle.port);
    assert.strictEqual(info.protocol, "http");
    await handle.done;
  });
});

describe("https transfer", () => {
  let downloadDir: string;

  beforeEach(() => {
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-tls-"));
  });

  afterEach(() => {
    fs.rmSync(downloadDir, { recursive: true, force: true });
  });

  it("transfers over TLS when a certificate can be made, and says so when it cannot", async () => {
    const config = makeConfig(downloadDir, { protocol: "https", requirePin: false });
    const handle = await receiveOnce(config, { downloadDir, pin: null, timeoutMs: 10_000 });

    if (handle.protocol === "http") {
      // openssl is unavailable in this environment: the documented fallback.
      assert.ok(handle.warnings.some((warning) => /certificate/i.test(warning)));
      await handle.done;
      return;
    }

    assert.strictEqual(handle.protocol, "https");
    await sendFiles(config, {
      peer: peerAt(handle.port, "https"),
      payloads: [{ fileName: "secure.txt", content: Buffer.from("over tls"), size: 8 }],
    });

    const received = await handle.done;
    assert.strictEqual(received.outcome, "completed");
    assert.strictEqual(fs.readFileSync(path.join(downloadDir, "secure.txt"), "utf-8"), "over tls");
  });
});

describe("coexisting with the LocalSend app on the same machine", () => {
  let downloadDir: string;
  let squatter: import("node:dgram").Socket | null = null;
  let tcpSquatter: import("node:net").Server | null = null;

  beforeEach(() => {
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-coexist-"));
  });

  afterEach(async () => {
    if (squatter) {
      await new Promise<void>((resolve) => squatter!.close(() => resolve()));
      squatter = null;
    }
    if (tcpSquatter) {
      await new Promise<void>((resolve) => tcpSquatter!.close(() => resolve()));
      tcpSquatter = null;
    }
    fs.rmSync(downloadDir, { recursive: true, force: true });
  });

  /** Occupy the ports the LocalSend desktop app holds while it runs. */
  async function occupyLocalSendPorts(): Promise<boolean> {
    const dgram = await import("node:dgram");
    const net = await import("node:net");

    const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const bound = await new Promise<boolean>((resolve) => {
      udp.once("error", () => resolve(false));
      udp.bind(53317, () => resolve(true));
    });
    if (!bound) return false;
    squatter = udp;

    const tcp = net.createServer();
    const tcpBound = await new Promise<boolean>((resolve) => {
      tcp.once("error", () => resolve(false));
      tcp.listen(53317, () => resolve(true));
    });
    if (tcpBound) tcpSquatter = tcp;
    return true;
  }

  it("still receives a transfer while port 53317 is taken", async (t) => {
    if (!(await occupyLocalSendPorts())) {
      return t.skip("could not occupy port 53317 in this environment");
    }

    const config = makeConfig(downloadDir, { requirePin: false });
    const handle = await receiveOnce(config, {
      downloadDir,
      pin: null,
      timeoutMs: 10_000,
    });

    // The receiver must have chosen a port of its own rather than fighting
    // for the one the app holds.
    assert.notStrictEqual(handle.port, 53317);

    await sendFiles(config, {
      peer: peerAt(handle.port),
      payloads: [{ fileName: "coexist.txt", content: Buffer.from("side by side"), size: 12 }],
    });

    const received = await handle.done;
    assert.strictEqual(received.outcome, "completed");
    assert.strictEqual(
      fs.readFileSync(path.join(downloadDir, "coexist.txt"), "utf-8"),
      "side by side",
    );
  });

  it("scans without failing when the app holds the multicast port", async (t) => {
    if (!(await occupyLocalSendPorts())) {
      return t.skip("could not occupy port 53317 in this environment");
    }

    const { discoverPeers } = await import("../src/discovery.ts");
    const outcome = await discoverPeers(makeConfig(downloadDir), { timeoutMs: 500 });

    // A busy multicast port is a documented degradation, never an error.
    assert.ok(Array.isArray(outcome.peers));
    assert.ok(outcome.listenPort > 0);
  });
});
