/**
 * localsend_devices tool -- Find LocalSend devices on the local network.
 *
 * Opens a UDP socket and a short-lived HTTP server for the duration of the
 * scan, then closes both.
 */

import { Type } from "typebox";
import { getConfig } from "../config.ts";
import { discoverPeers } from "../discovery.ts";
import { formatPeerList } from "../formatting/formatters.ts";

export const LocalSendDevicesTool = {
  name: "localsend_devices",
  label: "LocalSend Devices",
  description:
    "Scan the local network for devices running LocalSend and list their aliases and addresses. The other device must have LocalSend open. Nothing keeps listening after the scan.",
  parameters: Type.Object({
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "How long to wait for answers. Default 3, maximum 30.",
        default: 3,
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { timeoutSeconds?: number },
    signal: AbortSignal,
  ) {
    const seconds = Math.min(Math.max(params.timeoutSeconds ?? 3, 1), 30);
    const config = getConfig();

    const outcome = await discoverPeers(config, {
      timeoutMs: seconds * 1000,
      signal,
    });

    return {
      content: [
        { type: "text" as const, text: formatPeerList(outcome.peers, outcome.warnings) },
      ],
      details: {
        count: outcome.peers.length,
        devices: outcome.peers.map((peer) => ({
          alias: peer.alias,
          host: peer.host,
          port: peer.port,
          protocol: peer.protocol,
          deviceType: peer.deviceType,
        })),
        warnings: outcome.warnings,
      },
    };
  },
};
