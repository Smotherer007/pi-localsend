/**
 * The receiver's refusal paths, driven with raw HTTP.
 *
 * Everything here is what a hostile or buggy peer on the same network can
 * try, so each case asserts both the status code and that nothing unwanted
 * ended up on disk.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { receiveOnce, type ReceiveHandle } from "../src/server/receive-server.ts";
import { API_PREFIX, type LocalSendConfig } from "../src/types.ts";

interface RawResponse {
  status: number;
  body: any;
}

function call(
  port: number,
  method: string,
  urlPath: string,
  body?: string | Buffer,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": payload.length }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let parsed: any = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* keep the raw text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function prepareBody(files: Record<string, unknown>): string {
  return JSON.stringify({
    info: { alias: "peer", version: "2.1", fingerprint: "peer-fp" },
    files,
  });
}

const oneFile = prepareBody({
  f1: { id: "f1", fileName: "a.txt", size: 4, fileType: "text/plain" },
});

describe("receiver refusal paths", () => {
  let dir: string;
  let handle: ReceiveHandle;
  let config: LocalSendConfig;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-sec-"));
    config = {
      alias: "guard",
      deviceType: "headless",
      downloadDir: dir,
      protocol: "http",
      port: 0,
      requirePin: false,
      fingerprint: "guard-fp",
    };
    handle = await receiveOnce(config, { downloadDir: dir, pin: null, timeoutMs: 3000 });
  });

  afterEach(async () => {
    await handle.done;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("answers an unknown path with 404", async () => {
    const res = await call(handle.port, "GET", "/nope");
    assert.strictEqual(res.status, 404);
  });

  it("answers register with this device's info", async () => {
    const res = await call(
      handle.port,
      "POST",
      `${API_PREFIX}/register`,
      JSON.stringify({ alias: "peer", version: "2.1", fingerprint: "peer-fp" }),
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.alias, "guard");
    assert.strictEqual(res.body.port, handle.port);
  });

  it("rejects a prepare-upload with no files", async () => {
    const res = await call(handle.port, "POST", `${API_PREFIX}/prepare-upload`, prepareBody({}));
    assert.strictEqual(res.status, 400);
  });

  it("rejects a prepare-upload whose files have no name", async () => {
    const res = await call(
      handle.port,
      "POST",
      `${API_PREFIX}/prepare-upload`,
      prepareBody({ f1: { id: "f1", size: 4 } }),
    );
    assert.strictEqual(res.status, 400);
  });

  it("rejects an upload with missing parameters", async () => {
    const res = await call(handle.port, "POST", `${API_PREFIX}/upload?sessionId=x`, "data");
    assert.strictEqual(res.status, 400);
  });

  it("rejects an upload for an unknown session", async () => {
    const res = await call(
      handle.port,
      "POST",
      `${API_PREFIX}/upload?sessionId=ghost&fileId=f1&token=t`,
      "data",
    );
    assert.strictEqual(res.status, 409);
  });

  it("rejects an upload with a forged token", async () => {
    const prepared = await call(handle.port, "POST", `${API_PREFIX}/prepare-upload`, oneFile);
    assert.strictEqual(prepared.status, 200);

    const res = await call(
      handle.port,
      "POST",
      `${API_PREFIX}/upload?sessionId=${prepared.body.sessionId}&fileId=f1&token=not-the-token`,
      "data",
    );
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });

  it("rejects an upload for a file id that was never announced", async () => {
    const prepared = await call(handle.port, "POST", `${API_PREFIX}/prepare-upload`, oneFile);
    const res = await call(
      handle.port,
      "POST",
      `${API_PREFIX}/upload?sessionId=${prepared.body.sessionId}&fileId=other&token=x`,
      "data",
    );
    assert.strictEqual(res.status, 403);
  });

  it("refuses to accept the same file twice", async () => {
    // Two files, so the session is still open after the first upload: a
    // one-file session completes and the receiver shuts down immediately.
    const twoFiles = prepareBody({
      f1: { id: "f1", fileName: "a.txt", size: 4, fileType: "text/plain" },
      f2: { id: "f2", fileName: "b.txt", size: 4, fileType: "text/plain" },
    });
    const prepared = await call(handle.port, "POST", `${API_PREFIX}/prepare-upload`, twoFiles);
    const query = `sessionId=${prepared.body.sessionId}&fileId=f1&token=${prepared.body.files.f1}`;

    const first = await call(handle.port, "POST", `${API_PREFIX}/upload?${query}`, "data");
    assert.strictEqual(first.status, 200);

    const second = await call(handle.port, "POST", `${API_PREFIX}/upload?${query}`, "data");
    assert.strictEqual(second.status, 409);
  });

  it("shuts down as soon as the announced files have all arrived", async () => {
    const prepared = await call(handle.port, "POST", `${API_PREFIX}/prepare-upload`, oneFile);
    const query = `sessionId=${prepared.body.sessionId}&fileId=f1&token=${prepared.body.files.f1}`;

    const uploaded = await call(handle.port, "POST", `${API_PREFIX}/upload?${query}`, "data");
    assert.strictEqual(uploaded.status, 200);

    const result = await handle.done;
    assert.strictEqual(result.outcome, "completed");

    // Nothing is listening any more: the receiver does not outlive its transfer.
    await assert.rejects(
      () => call(handle.port, "GET", `${API_PREFIX}/info`),
      /ECONNREFUSED|socket hang up/,
    );
  });

  it("cuts off a sender that exceeds the size it declared", async () => {
    const prepared = await call(handle.port, "POST", `${API_PREFIX}/prepare-upload`, oneFile);
    const token = prepared.body.files.f1;

    await call(
      handle.port,
      "POST",
      `${API_PREFIX}/upload?sessionId=${prepared.body.sessionId}&fileId=f1&token=${token}`,
      Buffer.alloc(5000, 0x41),
    ).catch(() => undefined);

    // Discarding the partial file is asynchronous and can finish either side
    // of the client seeing the reset, so this waits for the directory to
    // settle rather than assuming an ordering.
    const deadline = Date.now() + 2000;
    let remaining = fs.readdirSync(dir);
    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      remaining = fs.readdirSync(dir);
    }

    // Neither the finished file nor its partial may survive.
    assert.deepStrictEqual(remaining, []);
  });

  it("refuses a second session while one is open", async () => {
    const first = await call(handle.port, "POST", `${API_PREFIX}/prepare-upload`, oneFile);
    assert.strictEqual(first.status, 200);

    const second = await call(handle.port, "POST", `${API_PREFIX}/prepare-upload`, oneFile);
    assert.strictEqual(second.status, 409);
  });

  it("ends the transfer when the sender cancels", async () => {
    const prepared = await call(handle.port, "POST", `${API_PREFIX}/prepare-upload`, oneFile);
    const res = await call(
      handle.port,
      "POST",
      `${API_PREFIX}/cancel?sessionId=${prepared.body.sessionId}`,
    );
    assert.strictEqual(res.status, 200);

    const result = await handle.done;
    assert.strictEqual(result.outcome, "cancelled");
  });
});

describe("PIN enforcement", () => {
  let dir: string;
  let handle: ReceiveHandle;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-pin-"));
    handle = await receiveOnce(
      {
        alias: "guard",
        deviceType: "headless",
        downloadDir: dir,
        protocol: "http",
        port: 0,
        requirePin: true,
        fingerprint: "guard-fp",
      },
      { downloadDir: dir, pin: "424242", timeoutMs: 3000 },
    );
  });

  afterEach(async () => {
    await handle.done;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a missing PIN", async () => {
    const res = await call(handle.port, "POST", `${API_PREFIX}/prepare-upload`, oneFile);
    assert.strictEqual(res.status, 401);
  });

  it("rejects a wrong PIN", async () => {
    const res = await call(
      handle.port,
      "POST",
      `${API_PREFIX}/prepare-upload?pin=000000`,
      oneFile,
    );
    assert.strictEqual(res.status, 401);
  });

  it("stops brute forcing after five attempts", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await call(
        handle.port,
        "POST",
        `${API_PREFIX}/prepare-upload?pin=00000${attempt}`,
        oneFile,
      );
      assert.strictEqual(res.status, 401, `attempt ${attempt} should be unauthorised`);
    }

    const blocked = await call(
      handle.port,
      "POST",
      `${API_PREFIX}/prepare-upload?pin=424242`,
      oneFile,
    );
    assert.strictEqual(blocked.status, 429);
  });

  it("accepts the correct PIN", async () => {
    const res = await call(
      handle.port,
      "POST",
      `${API_PREFIX}/prepare-upload?pin=424242`,
      oneFile,
    );
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.sessionId);
  });
});
