/**
 * Sending files to a LocalSend peer.
 *
 * Two steps per the protocol: announce the file list with prepare-upload and
 * get a session plus one token per file, then POST each file's bytes to
 * upload. Anything that goes wrong after a session exists is followed by a
 * best-effort cancel, so the peer does not sit on a half-open transfer.
 *
 * node:http/https is used rather than fetch because LocalSend peers use
 * self-signed certificates by design, and per-request TLS options are not
 * reachable through fetch.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type {
  FileDescriptor,
  LocalSendConfig,
  Peer,
  SendResult,
  SentFile,
} from "../types.ts";
import { API_PREFIX, PROTOCOL_VERSION, TransferRejectedError } from "../types.ts";
import { guessFileType, randomId } from "../net.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/** One item to send: either a file on disk or in-memory content. */
export interface Payload {
  readonly fileName: string;
  readonly path?: string;
  readonly content?: Buffer;
  readonly size: number;
  readonly fileType?: string;
  readonly modified?: string;
}

export interface SendOptions {
  readonly peer: Peer;
  readonly payloads: ReadonlyArray<Payload>;
  readonly pin?: string;
  readonly signal?: AbortSignal;
}

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

function requestOptions(peer: Peer, path: string, method: string, headers: http.OutgoingHttpHeaders) {
  return {
    host: peer.host,
    port: peer.port,
    path,
    method,
    headers,
    // LocalSend peers use self-signed certificates: the protocol's trust
    // anchor is the fingerprint, not a CA chain, so chain validation would
    // reject every legitimate peer.
    ...(peer.protocol === "https" ? { rejectUnauthorized: false } : {}),
  };
}

function send(
  peer: Peer,
  path: string,
  method: string,
  body: Buffer | fs.ReadStream | undefined,
  headers: http.OutgoingHttpHeaders,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawResponse> {
  const transport = peer.protocol === "https" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      requestOptions(peer, path, method, headers),
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
        res.on("error", reject);
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(
          `${peer.alias} did not respond within ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
    });

    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") {
        reject(
          new Error(
            `${peer.alias} (${peer.host}:${peer.port}) refused the connection. Is LocalSend still open on that device?`,
          ),
        );
        return;
      }
      if (err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH") {
        reject(new Error(`${peer.host} is not reachable from this machine.`));
        return;
      }
      reject(err);
    });

    const abort = () => req.destroy(new Error("Transfer cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    req.on("close", () => signal?.removeEventListener("abort", abort));

    if (!body) {
      req.end();
    } else if (Buffer.isBuffer(body)) {
      req.end(body);
    } else {
      body.on("error", (err) => req.destroy(err));
      body.pipe(req);
    }
  });
}

/** Translate the protocol's status codes into something a human can act on. */
function explainPrepareFailure(status: number, alias: string, body: string): TransferRejectedError {
  switch (status) {
    case 400:
      return new TransferRejectedError(status, `${alias} rejected the file list as invalid (400). ${body}`.trim());
    case 401:
      return new TransferRejectedError(
        status,
        `${alias} requires a PIN, or the PIN was wrong. Ask for the PIN shown on that device and pass it as 'pin'.`,
      );
    case 403:
      return new TransferRejectedError(status, `${alias} declined the transfer.`);
    case 409:
      return new TransferRejectedError(
        status,
        `${alias} is busy with another transfer. Wait for it to finish and try again.`,
      );
    case 429:
      return new TransferRejectedError(status, `${alias} is rate limiting requests. Wait a moment and try again.`);
    default:
      return new TransferRejectedError(
        status,
        `${alias} could not accept the transfer (HTTP ${status}). ${body}`.trim(),
      );
  }
}

export interface DescribedPayloads {
  readonly files: Record<string, FileDescriptor>;
  /** file id -> the payload to upload for it. */
  readonly byId: Map<string, Payload>;
}

export function buildFileDescriptors(
  payloads: ReadonlyArray<Payload>,
): DescribedPayloads {
  const files: Record<string, FileDescriptor> = {};
  const byId = new Map<string, Payload>();

  for (const payload of payloads) {
    const id = randomId();
    files[id] = {
      id,
      fileName: payload.fileName,
      size: payload.size,
      fileType: payload.fileType ?? guessFileType(payload.fileName),
      ...(payload.modified && { metadata: { modified: payload.modified } }),
    };
    // Keyed by id, so sending two different files that happen to share a
    // name still uploads the right bytes for each.
    byId.set(id, payload);
  }
  return { files, byId };
}

export async function sendFiles(
  config: LocalSendConfig,
  options: SendOptions,
): Promise<SendResult> {
  const { peer, payloads } = options;
  if (payloads.length === 0) {
    throw new Error("Nothing to send.");
  }

  const { files, byId } = buildFileDescriptors(payloads);

  const prepareBody = Buffer.from(
    JSON.stringify({
      info: {
        alias: config.alias,
        version: PROTOCOL_VERSION,
        deviceModel: config.deviceModel,
        deviceType: config.deviceType,
        fingerprint: config.fingerprint,
        port: config.port || undefined,
        protocol: config.protocol,
        download: false,
      },
      files,
    }),
    "utf-8",
  );

  const pinQuery = options.pin ? `?pin=${encodeURIComponent(options.pin)}` : "";
  const prepared = await send(
    peer,
    `${API_PREFIX}/prepare-upload${pinQuery}`,
    "POST",
    prepareBody,
    { "Content-Type": "application/json", "Content-Length": prepareBody.length },
    REQUEST_TIMEOUT_MS,
    options.signal,
  );

  // 204 means the receiver wants none of the files -- not an error, but
  // nothing was transferred either.
  if (prepared.status === 204) {
    return { peer, sessionId: "", files: [], bytesSent: 0 };
  }
  if (prepared.status !== 200) {
    throw explainPrepareFailure(prepared.status, peer.alias, prepared.body);
  }

  let sessionId = "";
  let tokens: Record<string, string> = {};
  try {
    const parsed = JSON.parse(prepared.body);
    sessionId = String(parsed.sessionId ?? "");
    tokens = parsed.files ?? {};
  } catch {
    throw new Error(`${peer.alias} sent an unreadable prepare-upload response.`);
  }
  if (!sessionId) {
    throw new Error(`${peer.alias} did not return a session id.`);
  }

  const results: SentFile[] = [];
  let bytesSent = 0;

  try {
    for (const [fileId, token] of Object.entries(tokens)) {
      const payload = byId.get(fileId);
      if (!payload) continue;

      const query = `?sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(fileId)}&token=${encodeURIComponent(token)}`;
      const body = payload.content ?? fs.createReadStream(payload.path!);

      const uploaded = await send(
        peer,
        `${API_PREFIX}/upload${query}`,
        "POST",
        body,
        {
          "Content-Type": "application/octet-stream",
          "Content-Length": payload.size,
        },
        UPLOAD_TIMEOUT_MS,
        options.signal,
      );

      if (uploaded.status >= 200 && uploaded.status < 300) {
        results.push({ fileName: payload.fileName, size: payload.size, ok: true });
        bytesSent += payload.size;
      } else {
        results.push({
          fileName: payload.fileName,
          size: payload.size,
          ok: false,
          error: `HTTP ${uploaded.status}${uploaded.body ? `: ${uploaded.body}` : ""}`,
        });
      }
    }
  } catch (err) {
    await cancelSession(peer, sessionId).catch(() => {});
    throw err;
  }

  // A partial failure leaves the peer waiting for the rest of the session.
  if (results.some((file) => !file.ok)) {
    await cancelSession(peer, sessionId).catch(() => {});
  }

  return { peer, sessionId, files: results, bytesSent };
}

export async function cancelSession(peer: Peer, sessionId: string): Promise<void> {
  await send(
    peer,
    `${API_PREFIX}/cancel?sessionId=${encodeURIComponent(sessionId)}`,
    "POST",
    undefined,
    {},
    5000,
  );
}
