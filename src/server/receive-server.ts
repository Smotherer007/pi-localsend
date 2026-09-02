/**
 * Receiving one transfer, then shutting down.
 *
 * There is deliberately no background daemon: this starts a server, accepts
 * a single session, writes its files and resolves. Whatever happens -- the
 * transfer completes, the timeout expires, the sender cancels, or the tool
 * call is aborted -- every socket is closed before the promise settles.
 */

import * as dgram from "node:dgram";
import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import type {
  DeviceInfo,
  FileDescriptor,
  LocalSendConfig,
  ReceivedFile,
  ReceiveResult,
} from "../types.ts";
import { API_PREFIX, MULTICAST_ADDRESS, DEFAULT_PORT } from "../types.ts";
import { constantTimeEquals, randomId, uniquePath } from "../net.ts";
import {
  buildDeviceInfo,
  normalizeRemoteAddress,
  readJsonBody,
  resolveTransport,
  sendJson,
  startServer,
  type Transport,
} from "./listener.ts";

const MAX_PIN_ATTEMPTS = 5;
const ANNOUNCE_INTERVAL_MS = 2000;

export interface ReceiveOptions {
  /** Where to write incoming files. */
  readonly downloadDir: string;
  /** PIN the sender must supply, or null to accept without one. */
  readonly pin: string | null;
  /** Give up if nobody sends anything within this window. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Called as each file lands, for progress output. */
  readonly onFile?: (file: ReceivedFile) => void;
}

export interface ReceiveHandle {
  /** Port peers should connect to, known before the first byte arrives. */
  readonly port: number;
  readonly protocol: "http" | "https";
  readonly warnings: ReadonlyArray<string>;
  /** Resolves when the transfer is done, times out or is cancelled. */
  readonly done: Promise<ReceiveResult>;
}

interface Session {
  readonly id: string;
  readonly senderAddress: string;
  readonly sender?: DeviceInfo;
  /** fileId -> token issued to the sender. */
  readonly tokens: Map<string, string>;
  readonly descriptors: Map<string, FileDescriptor>;
  readonly received: Set<string>;
}

function parseQuery(url: string): URLSearchParams {
  const index = url.indexOf("?");
  return new URLSearchParams(index === -1 ? "" : url.slice(index + 1));
}

function parseFiles(raw: unknown): Map<string, FileDescriptor> {
  const files = new Map<string, FileDescriptor>();
  if (!raw || typeof raw !== "object") return files;

  for (const [id, value] of Object.entries(raw as Record<string, any>)) {
    if (!value || typeof value !== "object") continue;
    const fileName = typeof value.fileName === "string" ? value.fileName : "";
    if (!fileName) continue;
    files.set(id, {
      id,
      fileName,
      size: Number.isFinite(value.size) && value.size >= 0 ? Number(value.size) : 0,
      fileType: typeof value.fileType === "string" ? value.fileType : "application/octet-stream",
      sha256: typeof value.sha256 === "string" ? value.sha256 : undefined,
    });
  }
  return files;
}

/**
 * Stream a request body to disk, never writing more than the sender
 * declared: the declared size is what the user was shown, so a body that
 * keeps going is either a bug or an attempt to fill the disk.
 */
function writeBody(
  req: http.IncomingMessage,
  target: string,
  maxBytes: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const partial = `${target}.part`;
    const stream = fs.createWriteStream(partial);
    let written = 0;
    let failed = false;

    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      // The partial file can only be removed once the stream has actually
      // closed its descriptor; unlinking earlier races with the final flush
      // and leaves a stray ".part" behind.
      const discard = () => fs.rm(partial, { force: true }, () => reject(err));
      if (stream.destroyed || stream.closed) {
        discard();
      } else {
        stream.once("close", discard);
        stream.destroy();
      }
    };

    req.on("data", (chunk: Buffer) => {
      written += chunk.length;
      if (maxBytes > 0 && written > maxBytes) {
        req.destroy();
        fail(new Error("Sender sent more data than it declared."));
        return;
      }
      if (!stream.write(chunk)) req.pause();
    });
    stream.on("drain", () => req.resume());
    req.on("error", fail);
    stream.on("error", fail);

    req.on("end", () => {
      if (failed) return;
      stream.end(() => {
        try {
          fs.renameSync(partial, target);
          resolve(written);
        } catch (err) {
          fail(err as Error);
        }
      });
    });
  });
}

/**
 * Start listening for exactly one incoming transfer.
 *
 * Resolves the handle as soon as the port is known, so the caller can show
 * the address and PIN before awaiting `done`.
 */
export async function receiveOnce(
  config: LocalSendConfig,
  options: ReceiveOptions,
): Promise<ReceiveHandle> {
  const transport = resolveTransport(config);
  const warnings: string[] = [];
  if (transport.downgradeReason) warnings.push(transport.downgradeReason);

  fs.mkdirSync(options.downloadDir, { recursive: true });

  let session: Session | null = null;
  let pinAttempts = 0;
  const files: ReceivedFile[] = [];
  let bytesReceived = 0;
  let settled = false;
  let listenPort = 0;

  let finish: (result: ReceiveResult) => void = () => {};
  const done = new Promise<ReceiveResult>((resolve) => {
    finish = resolve;
  });

  const complete = (outcome: ReceiveResult["outcome"]) => {
    if (settled) return;
    settled = true;
    void shutdown().then(() =>
      finish({
        files,
        sender: session?.sender,
        senderAddress: session?.senderAddress,
        bytesReceived,
        outcome,
      }),
    );
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? "";
    const remote = normalizeRemoteAddress(req.socket.remoteAddress);

    try {
      if (req.method === "GET" && url.startsWith(`${API_PREFIX}/info`)) {
        sendJson(res, 200, buildDeviceInfo(config, transport, listenPort, false));
        return;
      }

      if (req.method === "POST" && url.startsWith(`${API_PREFIX}/register`)) {
        // A peer announcing itself; answer with who we are so we show up in
        // its device list.
        await readJsonBody(req).catch(() => undefined);
        sendJson(res, 200, buildDeviceInfo(config, transport, listenPort, false));
        return;
      }

      if (req.method === "POST" && url.startsWith(`${API_PREFIX}/prepare-upload`)) {
        if (session) {
          sendJson(res, 409, { message: "Another transfer is already in progress" });
          return;
        }
        if (options.pin) {
          if (pinAttempts >= MAX_PIN_ATTEMPTS) {
            sendJson(res, 429, { message: "Too many incorrect PIN attempts" });
            return;
          }
          const supplied = parseQuery(url).get("pin") ?? "";
          if (!constantTimeEquals(supplied, options.pin)) {
            pinAttempts += 1;
            sendJson(res, 401, { message: "PIN required or invalid" });
            return;
          }
        }

        const body = (await readJsonBody(req)) as
          | { info?: DeviceInfo; files?: unknown }
          | undefined;
        const descriptors = parseFiles(body?.files);
        if (descriptors.size === 0) {
          sendJson(res, 400, { message: "No files in request" });
          return;
        }

        const tokens = new Map<string, string>();
        const response: Record<string, string> = {};
        for (const id of descriptors.keys()) {
          const token = randomId();
          tokens.set(id, token);
          response[id] = token;
        }

        session = {
          id: randomId(),
          senderAddress: remote,
          sender: body?.info,
          tokens,
          descriptors,
          received: new Set(),
        };
        sendJson(res, 200, { sessionId: session.id, files: response });
        return;
      }

      if (req.method === "POST" && url.startsWith(`${API_PREFIX}/upload`)) {
        const query = parseQuery(url);
        const sessionId = query.get("sessionId") ?? "";
        const fileId = query.get("fileId") ?? "";
        const token = query.get("token") ?? "";

        if (!sessionId || !fileId || !token) {
          sendJson(res, 400, { message: "Missing parameters" });
          return;
        }
        if (!session || session.id !== sessionId) {
          sendJson(res, 409, { message: "Unknown or finished session" });
          return;
        }
        // Binding the session to the address that opened it stops a second
        // device on the LAN from uploading into someone else's session.
        if (session.senderAddress && remote !== session.senderAddress) {
          sendJson(res, 403, { message: "Invalid IP address for this session" });
          return;
        }
        const expected = session.tokens.get(fileId);
        if (!expected || !constantTimeEquals(token, expected)) {
          sendJson(res, 403, { message: "Invalid token" });
          return;
        }
        if (session.received.has(fileId)) {
          sendJson(res, 409, { message: "File already uploaded" });
          return;
        }

        const descriptor = session.descriptors.get(fileId)!;
        // uniquePath sanitises the peer-supplied name and keeps the write
        // inside the download directory.
        const target = uniquePath(options.downloadDir, descriptor.fileName);
        const written = await writeBody(req, target, descriptor.size);

        session.received.add(fileId);
        const record: ReceivedFile = {
          fileName: path.basename(target),
          path: target,
          size: written,
        };
        files.push(record);
        bytesReceived += written;
        options.onFile?.(record);

        // Shutting down destroys open sockets, so the last response has to
        // be on the wire before the transfer counts as finished.
        const finished = session.received.size >= session.descriptors.size;
        res.on("finish", () => {
          if (finished) complete("completed");
        });
        sendJson(res, 200, {});
        return;
      }

      if (req.method === "POST" && url.startsWith(`${API_PREFIX}/cancel`)) {
        const cancelled =
          !!session && session.id === (parseQuery(url).get("sessionId") ?? session.id);
        res.on("finish", () => {
          if (cancelled) complete("cancelled");
        });
        sendJson(res, 200, {});
        return;
      }

      sendJson(res, 404, { message: "Not found" });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: (err as Error).message });
      }
    }
  };

  const server = await startServer(transport, handler, config.port);
  listenPort = server.port;

  // Announce ourselves so peers list us without the user typing an address.
  const announcer = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const announcement = Buffer.from(
    JSON.stringify(buildDeviceInfo(config, transport, listenPort, true)),
    "utf-8",
  );
  let announceTimer: NodeJS.Timeout | null = null;

  await new Promise<void>((resolve) => {
    announcer.once("error", () => resolve());
    announcer.bind(0, () => {
      try {
        announcer.setMulticastTTL(1);
      } catch {
        /* not fatal */
      }
      resolve();
    });
  });

  const announce = () => {
    try {
      announcer.send(announcement, DEFAULT_PORT, MULTICAST_ADDRESS);
    } catch {
      /* interface may be down; the peer can still be given the address */
    }
  };
  announce();
  announceTimer = setInterval(announce, ANNOUNCE_INTERVAL_MS);
  announceTimer.unref?.();

  const timeoutTimer = setTimeout(() => complete("timeout"), options.timeoutMs);
  timeoutTimer.unref?.();

  const onAbort = () => complete("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  async function shutdown(): Promise<void> {
    if (announceTimer) clearInterval(announceTimer);
    clearTimeout(timeoutTimer);
    options.signal?.removeEventListener("abort", onAbort);
    try {
      announcer.close();
    } catch {
      /* already closed */
    }
    await server.close();
  }

  return { port: listenPort, protocol: transport.protocol, warnings, done };
}
