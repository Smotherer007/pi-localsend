/**
 * Finding LocalSend devices on the local network.
 *
 * The protocol's primary path is: we send a multicast announcement with
 * `announce: true`, and every device that hears it answers with an HTTP POST
 * to /api/localsend/v2/register on the port we advertised. So a scan needs a
 * short-lived HTTP server as well as a UDP socket. Both are closed before
 * this function returns -- nothing keeps listening in the background.
 */

import * as dgram from "node:dgram";
import type { DeviceInfo, LocalSendConfig, Peer } from "./types.ts";
import { API_PREFIX, DEFAULT_PORT, MULTICAST_ADDRESS } from "./types.ts";
import {
  buildDeviceInfo,
  normalizeRemoteAddress,
  readJsonBody,
  resolveTransport,
  sendJson,
  startServer,
  type Transport,
} from "./server/listener.ts";

export interface DiscoveryOptions {
  /** How long to listen for answers. Default 3000 ms. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DiscoveryOutcome {
  readonly peers: Peer[];
  /** Non-fatal problems worth telling the user about. */
  readonly warnings: string[];
  readonly listenPort: number;
  readonly protocol: "http" | "https";
}

function isDeviceInfo(value: unknown): value is DeviceInfo {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as DeviceInfo).alias === "string" &&
    typeof (value as DeviceInfo).fingerprint === "string"
  );
}

/** Turn an announcement plus the address it came from into a Peer. */
export function toPeer(info: DeviceInfo, host: string): Peer {
  return {
    alias: info.alias,
    host,
    port: typeof info.port === "number" && info.port > 0 ? info.port : DEFAULT_PORT,
    protocol: info.protocol === "http" ? "http" : "https",
    fingerprint: info.fingerprint,
    deviceModel: info.deviceModel,
    deviceType: info.deviceType,
    download: info.download,
  };
}

/** Collects peers, ignoring ourselves and collapsing duplicate answers. */
export class PeerCollector {
  private readonly peers = new Map<string, Peer>();
  private readonly ownFingerprint: string;

  // A plain field rather than a parameter property: pi runs TypeScript
  // through Node's strip-only transform, which does not support those.
  constructor(ownFingerprint: string) {
    this.ownFingerprint = ownFingerprint;
  }

  add(info: unknown, host: string): void {
    if (!isDeviceInfo(info) || !host) return;
    // Our own multicast comes back to us on most stacks.
    if (info.fingerprint && info.fingerprint === this.ownFingerprint) return;

    const peer = toPeer(info, host);
    // Key on address rather than fingerprint: an http peer's fingerprint is
    // just a random string and two devices could in principle collide.
    this.peers.set(`${peer.host}:${peer.port}`, peer);
  }

  list(): Peer[] {
    return [...this.peers.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Announce this device and collect whoever answers.
 *
 * The returned peers are whatever responded within the timeout; a device
 * that is asleep or on another subnet simply will not appear.
 */
export async function discoverPeers(
  config: LocalSendConfig,
  options: DiscoveryOptions = {},
): Promise<DiscoveryOutcome> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const transport = resolveTransport(config);
  const warnings: string[] = [];
  if (transport.downgradeReason) warnings.push(transport.downgradeReason);

  const collector = new PeerCollector(transport.fingerprint);

  // 1. A server to receive the HTTP registrations peers send back.
  // The port is only known once listening has started, and the handler reads
  // it, so it lives in a binding both can see.
  let listenPort = 0;
  const server = await startServer(
    transport,
    async (req, res) => {
      const url = req.url ?? "";
      const host = normalizeRemoteAddress(req.socket.remoteAddress);

      if (req.method === "POST" && url.startsWith(`${API_PREFIX}/register`)) {
        try {
          collector.add(await readJsonBody(req), host);
        } catch {
          /* a malformed registration is simply ignored */
        }
        sendJson(res, 200, buildDeviceInfo(config, transport, listenPort, false));
        return;
      }

      if (req.method === "GET" && url.startsWith(`${API_PREFIX}/info`)) {
        sendJson(res, 200, buildDeviceInfo(config, transport, listenPort, false));
        return;
      }

      sendJson(res, 404, { message: "Not found" });
    },
    config.port,
  );
  listenPort = server.port;

  // 2. A UDP socket to send the announcement. Binding to an ephemeral port is
  //    enough to transmit; joining the group on 53317 additionally picks up
  //    peers that answer by multicast, but that port is often already taken
  //    by the LocalSend app, so failure there is not fatal.
  const sender = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let listenerSocket: dgram.Socket | null = null;

  const cleanup = async () => {
    try {
      sender.close();
    } catch {
      /* already closed */
    }
    if (listenerSocket) {
      try {
        listenerSocket.close();
      } catch {
        /* already closed */
      }
    }
    await server.close();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      sender.once("error", reject);
      sender.bind(0, () => {
        try {
          sender.setBroadcast(true);
          sender.setMulticastTTL(1);
        } catch {
          /* not fatal on every platform */
        }
        resolve();
      });
    });

    listenerSocket = await joinMulticast(collector, warnings);

    const announcement = Buffer.from(
      JSON.stringify(buildDeviceInfo(config, transport, listenPort, true)),
      "utf-8",
    );

    // Three bursts: UDP is lossy, and a single lost packet would look
    // exactly like "no devices on the network".
    const bursts = [0, 400, 1200].filter((at) => at < timeoutMs);
    for (const at of bursts) {
      void delay(at, options.signal).then(() => {
        try {
          sender.send(announcement, DEFAULT_PORT, MULTICAST_ADDRESS);
        } catch {
          /* interface may have gone away mid-scan */
        }
      });
    }

    await delay(timeoutMs, options.signal);
  } finally {
    await cleanup();
  }

  return { peers: collector.list(), warnings, listenPort, protocol: transport.protocol };
}

/**
 * Listen on the multicast port for announcements from peers. Returns null
 * when the port is unavailable, which is normal if the LocalSend app runs
 * alongside us.
 */
function joinMulticast(
  collector: PeerCollector,
  warnings: string[],
): Promise<dgram.Socket | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;

    socket.on("error", () => {
      if (!settled) {
        settled = true;
        warnings.push(
          `Could not listen on UDP ${DEFAULT_PORT} (the LocalSend app may be running). Devices that answer by multicast instead of HTTP may be missed.`,
        );
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        resolve(null);
      }
    });

    socket.on("message", (message, rinfo) => {
      try {
        collector.add(JSON.parse(message.toString("utf-8")), rinfo.address);
      } catch {
        /* not a LocalSend packet */
      }
    });

    socket.bind(DEFAULT_PORT, () => {
      try {
        socket.addMembership(MULTICAST_ADDRESS);
      } catch {
        /* no multicast-capable interface; HTTP registrations still work */
      }
      if (!settled) {
        settled = true;
        resolve(socket);
      }
    });
  });
}

/** Match a peer by alias (case-insensitive), fingerprint, or host. */
export function findPeer(peers: ReadonlyArray<Peer>, needle: string): Peer | undefined {
  const target = needle.trim().toLowerCase();
  return (
    peers.find((peer) => peer.alias.toLowerCase() === target) ??
    peers.find((peer) => peer.fingerprint.toLowerCase() === target) ??
    peers.find((peer) => peer.host === needle.trim()) ??
    peers.find((peer) => peer.alias.toLowerCase().includes(target))
  );
}
