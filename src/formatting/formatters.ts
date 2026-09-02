/**
 * Output formatters.
 *
 * Pure functions that transform domain data into display strings.
 * No emojis, no side effects.
 */

import type {
  LocalSendConfig,
  ListenerAddress,
  Peer,
  ReceiveResult,
  SendResult,
} from "../types.ts";
import { formatBytes } from "../net.ts";

export function formatPeerList(
  peers: ReadonlyArray<Peer>,
  warnings: ReadonlyArray<string> = [],
): string {
  const sections: string[] = [];

  if (peers.length === 0) {
    sections.push(
      "No LocalSend devices answered.",
      "",
      "Things worth checking:",
      "- LocalSend is actually open on the other device (it only answers while the app is running).",
      "- Both devices are on the same network, and it is not a guest network that isolates clients.",
      "- A firewall is not blocking UDP 53317.",
      "If the device does not show up but you know its IP, localsend_send accepts host and port directly.",
    );
  } else {
    sections.push(`LocalSend devices on this network (${peers.length}):`);
    for (const peer of peers) {
      const model = peer.deviceModel ? ` -- ${peer.deviceModel}` : "";
      const type = peer.deviceType ? ` (${peer.deviceType})` : "";
      sections.push(
        `- ${peer.alias}${type}${model}`,
        `  ${peer.protocol}://${peer.host}:${peer.port}`,
      );
    }
    sections.push("", "Send to one with localsend_send, using its alias as 'to'.");
  }

  if (warnings.length > 0) {
    sections.push("", "Notes:", ...warnings.map((warning) => `- ${warning}`));
  }
  return sections.join("\n");
}

export function formatSendResult(result: SendResult): string {
  if (result.files.length === 0) {
    return `${result.peer.alias} accepted the request but wanted none of the files, so nothing was transferred.`;
  }

  const ok = result.files.filter((file) => file.ok);
  const failed = result.files.filter((file) => !file.ok);

  const lines = [
    failed.length === 0
      ? `Sent ${ok.length} file(s) to ${result.peer.alias} (${formatBytes(result.bytesSent)}):`
      : `Sent ${ok.length} of ${result.files.length} file(s) to ${result.peer.alias} (${formatBytes(result.bytesSent)}):`,
    ...ok.map((file) => `- ${file.fileName} (${formatBytes(file.size)})`),
  ];

  if (failed.length > 0) {
    lines.push("", "Failed:");
    for (const file of failed) {
      lines.push(`- ${file.fileName}: ${file.error ?? "unknown error"}`);
    }
  }
  return lines.join("\n");
}

export function formatReceiveResult(result: ReceiveResult, downloadDir: string): string {
  const sender = result.sender?.alias
    ? `${result.sender.alias}${result.senderAddress ? ` (${result.senderAddress})` : ""}`
    : result.senderAddress || "an unknown device";

  if (result.outcome === "timeout") {
    return [
      "No transfer arrived before the time ran out; the receiver has shut down.",
      "Start it again with localsend_receive when the other device is ready.",
    ].join("\n");
  }

  if (result.files.length === 0) {
    return result.outcome === "cancelled"
      ? "The transfer was cancelled before any file arrived. The receiver has shut down."
      : "The transfer finished without any files. The receiver has shut down.";
  }

  const lines = [
    result.outcome === "cancelled"
      ? `Transfer from ${sender} was cancelled partway through. Files that did arrive (${formatBytes(result.bytesReceived)}):`
      : `Received ${result.files.length} file(s) from ${sender} (${formatBytes(result.bytesReceived)}):`,
    ...result.files.map((file) => `- ${file.path} (${formatBytes(file.size)})`),
    "",
    `Saved in ${downloadDir}. The receiver has shut down.`,
  ];
  return lines.join("\n");
}

export function formatListening(
  address: ListenerAddress,
  pin: string | null,
  timeoutSeconds: number,
): string {
  const lines = [
    `Waiting for one incoming transfer for up to ${timeoutSeconds}s.`,
    `Listening on ${address.protocol} port ${address.port}.`,
  ];
  if (address.addresses.length > 0) {
    lines.push(
      `This machine is reachable at: ${address.addresses.map((ip) => `${ip}:${address.port}`).join(", ")}`,
    );
  }
  lines.push(
    pin
      ? `PIN: ${pin} -- enter it on the sending device when asked.`
      : "No PIN: any device on this network can send during this window.",
  );
  return lines.join("\n");
}

export function formatStatus(
  config: LocalSendConfig,
  addresses: ReadonlyArray<string>,
  saved: boolean,
  httpsAvailable: boolean,
): string {
  const lines = [
    `Alias: ${config.alias}`,
    `Device: ${config.deviceModel ?? "(unset)"} (${config.deviceType})`,
    `Downloads go to: ${config.downloadDir}`,
    `Transport: ${config.protocol}${config.protocol === "https" && !httpsAvailable ? " -- no certificate available, transfers will fall back to http" : ""}`,
    `Port: ${config.port === 0 ? "0 (a free port is picked per transfer)" : config.port}`,
    `PIN for incoming transfers: ${config.requirePin ? "required" : "not required"}`,
    `Fingerprint: ${config.fingerprint.slice(0, 16)}...`,
    "",
    addresses.length > 0
      ? `Local addresses: ${addresses.join(", ")}`
      : "No non-local network interface found -- other devices will not be able to reach this machine.",
    "",
    saved
      ? "Settings were customised with localsend_setup."
      : "Using defaults; localsend_setup can change them.",
    "Nothing is listening right now: a server only runs during localsend_receive or localsend_devices.",
  ];
  return lines.join("\n");
}
