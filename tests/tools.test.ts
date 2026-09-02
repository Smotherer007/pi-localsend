/**
 * Tool-level tests: argument validation, and the two transfer tools driven
 * against each other over loopback so the tool layer itself is exercised.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testHome = path.join(os.tmpdir(), "pi-localsend-tools-" + Date.now());
const originalHome = process.env.HOME;
process.env.HOME = testHome;
fs.mkdirSync(path.join(testHome, ".pi"), { recursive: true, mode: 0o700 });

const { LocalSendSendTool } = await import("../src/tools/localsend-send.ts");
const { LocalSendReceiveTool } = await import("../src/tools/localsend-receive.ts");
const { LocalSendStatusTool } = await import("../src/tools/localsend-status.ts");
const { LocalSendSetupTool } = await import("../src/tools/localsend-setup.ts");
const { LocalSendDevicesTool } = await import("../src/tools/localsend-devices.ts");

const signal = new AbortController().signal;
let downloadDir: string;
let sourceDir: string;

before(() => {
  downloadDir = path.join(testHome, "incoming");
  sourceDir = path.join(testHome, "outgoing");
  fs.mkdirSync(sourceDir, { recursive: true });
  LocalSendSetupTool.execute("1", { alias: "pi test", downloadDir }, signal);
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

/** Start the receive tool and resolve once it reports its listening port. */
function startReceiver(params: Record<string, unknown> = {}) {
  let announce: (port: number) => void = () => {};
  const listening = new Promise<number>((resolve) => {
    announce = resolve;
  });

  let pin: string | null = null;
  const finished = LocalSendReceiveTool.execute(
    "recv",
    { timeoutSeconds: 10, ...params },
    signal,
    (update: any) => {
      const text = String(update?.text ?? "");
      pin = /PIN: (\d{6})/.exec(text)?.[1] ?? null;
      const port = Number(/port (\d+)/.exec(text)?.[1]);
      if (Number.isFinite(port)) announce(port);
    },
  );

  return { finished, listening, pin: () => pin };
}

describe("localsend_setup", () => {
  it("rejects an invalid device type", () => {
    assert.throws(
      () => LocalSendSetupTool.execute("1", { deviceType: "toaster" }, signal),
      /Invalid deviceType/,
    );
  });

  it("saves the alias and reports the new settings", () => {
    const result = LocalSendSetupTool.execute("1", { alias: "pi test" }, signal);
    assert.strictEqual(result.details.alias, "pi test");
    assert.match(result.content[0].text, /LocalSend settings saved/);
  });
});

describe("localsend_status", () => {
  it("reports settings without opening a port", () => {
    const result = LocalSendStatusTool.execute("1", {}, signal);
    assert.strictEqual(result.details.alias, "pi test");
    assert.strictEqual(result.details.downloadDir, downloadDir);
    assert.match(result.content[0].text, /Nothing is listening right now/);
  });
});

describe("localsend_devices", () => {
  it("completes a scan and closes everything it opened", async () => {
    const result = await LocalSendDevicesTool.execute("1", { timeoutSeconds: 1 }, signal);
    assert.strictEqual(typeof result.details.count, "number");
    assert.ok(Array.isArray(result.details.devices));
  });
});

describe("localsend_send validation", () => {
  it("requires a target", async () => {
    await assert.rejects(
      () => LocalSendSendTool.execute("1", { to: "  ", text: "hi" }, signal),
      /must name a device alias or an address/,
    );
  });

  it("requires something to send", async () => {
    await assert.rejects(
      () => LocalSendSendTool.execute("1", { to: "127.0.0.1" }, signal),
      /Nothing to send/,
    );
  });

  it("rejects an unknown protocol", async () => {
    await assert.rejects(
      () =>
        LocalSendSendTool.execute(
          "1",
          { to: "127.0.0.1", text: "hi", protocol: "ftp" },
          signal,
        ),
      /Invalid protocol/,
    );
  });

  it("reports a missing file rather than sending nothing", async () => {
    await assert.rejects(
      () =>
        LocalSendSendTool.execute(
          "1",
          { to: "127.0.0.1", files: [path.join(sourceDir, "nope.txt")] },
          signal,
        ),
      /File not found/,
    );
  });

  it("says so when a device alias cannot be found", async () => {
    await assert.rejects(
      () =>
        LocalSendSendTool.execute(
          "1",
          { to: "No Such Device", text: "hi", timeoutSeconds: 1 },
          signal,
        ),
      (err: any) => {
        assert.strictEqual(err.name, "PeerNotFoundError");
        assert.match(err.message, /localsend_devices/);
        return true;
      },
    );
  });
});

describe("localsend_send and localsend_receive over loopback", () => {
  it("sends files and a text snippet, and the receiver saves them", async () => {
    const filePath = path.join(sourceDir, "doc.txt");
    fs.writeFileSync(filePath, "file body");

    const receiver = startReceiver();
    const port = await receiver.listening;
    const pin = receiver.pin();
    assert.match(String(pin), /^\d{6}$/);

    const sent = await LocalSendSendTool.execute(
      "send",
      {
        to: "127.0.0.1",
        port,
        protocol: "http",
        pin: pin!,
        files: [filePath],
        text: "a short note",
        textFileName: "note.txt",
      },
      signal,
    );

    assert.strictEqual(sent.details.okCount, 2);
    assert.strictEqual(sent.details.protocol, "http");

    const received = await receiver.finished;
    assert.strictEqual(received.details.outcome, "completed");
    assert.strictEqual(received.details.fileCount, 2);
    assert.match(received.content[0].text, /PIN: \d{6}/);
    assert.strictEqual(
      fs.readFileSync(path.join(downloadDir, "note.txt"), "utf-8"),
      "a short note",
    );
    assert.strictEqual(
      fs.readFileSync(path.join(downloadDir, "doc.txt"), "utf-8"),
      "file body",
    );
  });

  it("sends the files directly inside a directory, not subdirectories", async () => {
    const tree = path.join(sourceDir, "tree");
    fs.mkdirSync(path.join(tree, "nested"), { recursive: true });
    fs.writeFileSync(path.join(tree, "top.txt"), "top");
    fs.writeFileSync(path.join(tree, "nested", "deep.txt"), "deep");

    const receiver = startReceiver({ noPin: true, downloadDir: path.join(testHome, "dirtest") });
    const port = await receiver.listening;

    const sent = await LocalSendSendTool.execute(
      "send",
      { to: "127.0.0.1", port, protocol: "http", files: [tree] },
      signal,
    );

    assert.strictEqual(sent.details.fileCount, 1);
    const received = await receiver.finished;
    assert.deepStrictEqual(
      received.details.files.map((file: string) => path.basename(file)),
      ["top.txt"],
    );
  });

  it("runs without a PIN when asked to", async () => {
    const receiver = startReceiver({
      noPin: true,
      downloadDir: path.join(testHome, "nopin"),
    });
    const port = await receiver.listening;

    await LocalSendSendTool.execute(
      "send",
      { to: "127.0.0.1", port, protocol: "http", text: "open" },
      signal,
    );

    const received = await receiver.finished;
    assert.strictEqual(received.details.pinUsed, false);
    assert.strictEqual(received.details.outcome, "completed");
    assert.match(received.content[0].text, /any device on this network can send/);
  });

  it("reports a refused connection in plain language", async () => {
    await assert.rejects(
      () =>
        LocalSendSendTool.execute(
          "1",
          { to: "127.0.0.1", port: 1, protocol: "http", text: "hi" },
          signal,
        ),
      /refused the connection|not reachable/,
    );
  });
});
