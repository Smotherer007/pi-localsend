/**
 * Shared HTTP(S) listener plumbing.
 *
 * Both discovery and receiving need a short-lived server that speaks the
 * transport we advertise in our announcement, so the choice of http vs https
 * and the matching fingerprint are resolved in one place.
 */

import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import type { DeviceInfo, LocalSendConfig } from "../types.ts";
import { PROTOCOL_VERSION } from "../types.ts";
import { ensureTlsMaterial } from "../tls.ts";

export interface Transport {
  readonly protocol: "http" | "https";
  readonly tls: { cert: string; key: string } | null;
  /** Certificate hash for https, or the stable random id for http. */
  readonly fingerprint: string;
  /** Set when https was asked for but could not be provided. */
  readonly downgradeReason?: string;
}

/**
 * Decide how to listen. Asking for https without a way to make a certificate
 * downgrades to http rather than failing: the protocol allows it, and a
 * transfer that works beats one that does not.
 */
export function resolveTransport(config: LocalSendConfig): Transport {
  if (config.protocol !== "https") {
    return { protocol: "http", tls: null, fingerprint: config.fingerprint };
  }

  const material = ensureTlsMaterial();
  if (!material) {
    return {
      protocol: "http",
      tls: null,
      fingerprint: config.fingerprint,
      downgradeReason:
        "https was requested but no certificate could be created (the ~/.pi directory may not be writable), so this transfer uses plain http.",
    };
  }

  return {
    protocol: "https",
    tls: { cert: material.cert, key: material.key },
    fingerprint: material.fingerprint,
  };
}

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

export type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

/** Start listening, resolving once the port is known. */
export function startServer(
  transport: Transport,
  handler: Handler,
  port: number,
): Promise<RunningServer> {
  const server =
    transport.tls
      ? https.createServer({ cert: transport.tls.cert, key: transport.tls.key }, handler)
      : http.createServer(handler);

  // Sockets are tracked so close() cannot hang on a peer that keeps the
  // connection open after the transfer is done.
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use -- the LocalSend app itself is probably running. Close it, or configure a different port with localsend_setup (port 0 picks a free one).`,
          ),
        );
        return;
      }
      reject(err);
    });

    server.listen(port, () => {
      const actual = (server.address() as AddressInfo).port;
      resolve({
        port: actual,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** The announcement/registration body describing this device. */
export function buildDeviceInfo(
  config: LocalSendConfig,
  transport: Transport,
  port: number,
  announce: boolean,
): DeviceInfo {
  return {
    alias: config.alias,
    version: PROTOCOL_VERSION,
    deviceModel: config.deviceModel,
    deviceType: config.deviceType,
    fingerprint: transport.fingerprint,
    port,
    protocol: transport.protocol,
    download: false,
    ...(announce && { announce: true }),
  };
}

/** Normalise the address Node reports for an incoming connection. */
export function normalizeRemoteAddress(address?: string | null): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Read a JSON request body with a hard size cap. */
export function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = 5 * 1024 * 1024,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}
