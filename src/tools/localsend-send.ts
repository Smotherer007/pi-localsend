/**
 * localsend_send tool -- Send files or a text snippet to a device.
 *
 * The target can be an alias (resolved by a quick scan) or a host address
 * when discovery does not work on the network in question.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { getConfig } from "../config.ts";
import { discoverPeers, findPeer } from "../discovery.ts";
import { sendFiles, type Payload } from "../clients/send-client.ts";
import { expandPath, formatBytes } from "../net.ts";
import { formatSendResult } from "../formatting/formatters.ts";
import { DEFAULT_PORT, PeerNotFoundError, type Peer } from "../types.ts";

const MAX_FILES = 100;

/** Anything that looks like an address is used as-is instead of scanned for. */
function looksLikeHost(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || /^[a-z0-9-]+\.local$/i.test(value);
}

function collectPayloads(filePaths: ReadonlyArray<string>): Payload[] {
  const payloads: Payload[] = [];

  for (const raw of filePaths) {
    const resolved = expandPath(raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`File not found: ${resolved}`);
    }

    if (stat.isDirectory()) {
      // Directories are expanded one level: LocalSend has no folder concept,
      // so recursing would silently flatten a tree into one directory.
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const child = path.join(resolved, entry.name);
        const childStat = fs.statSync(child);
        payloads.push({
          fileName: entry.name,
          path: child,
          size: childStat.size,
          modified: childStat.mtime.toISOString(),
        });
      }
      continue;
    }

    payloads.push({
      fileName: path.basename(resolved),
      path: resolved,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }

  return payloads;
}

export const LocalSendSendTool = {
  name: "localsend_send",
  label: "LocalSend Send",
  description:
    "Send one or more files, or a short text, to a LocalSend device on the local network. Give 'to' as the device alias (found by a quick scan) or as an IP address. The other device must have LocalSend open, and may ask its user to accept or to supply a PIN.",
  parameters: Type.Object({
    to: Type.String({
      description:
        "Target device: its LocalSend alias, or an IP address such as 192.168.1.42.",
    }),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Paths of files to send. A directory sends the files directly inside it, not subdirectories. Absolute paths are safest.",
      }),
    ),
    text: Type.Optional(
      Type.String({
        description: "Send this text as a small .txt file instead of, or alongside, files.",
      }),
    ),
    textFileName: Type.Optional(
      Type.String({ description: "File name for 'text'. Defaults to message.txt." }),
    ),
    pin: Type.Optional(
      Type.String({ description: "PIN shown on the receiving device, if it asks for one." }),
    ),
    port: Type.Optional(
      Type.Number({
        description: `Port of the target when 'to' is an address. Defaults to ${DEFAULT_PORT}.`,
      }),
    ),
    protocol: Type.Optional(
      Type.String({
        description:
          "Transport of the target when 'to' is an address: https (default, what the LocalSend app uses) or http.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({ description: "How long to scan for the alias. Default 4.", default: 4 }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: {
      to: string;
      files?: string[];
      text?: string;
      textFileName?: string;
      pin?: string;
      port?: number;
      protocol?: string;
      timeoutSeconds?: number;
    },
    signal: AbortSignal,
  ) {
    if (!params.to || !params.to.trim()) {
      throw new Error("'to' must name a device alias or an address.");
    }
    if ((!params.files || params.files.length === 0) && !params.text) {
      throw new Error("Nothing to send: pass 'files', 'text', or both.");
    }
    if (params.protocol && params.protocol !== "http" && params.protocol !== "https") {
      throw new Error(`Invalid protocol "${params.protocol}". Use http or https.`);
    }

    const config = getConfig();

    const payloads: Payload[] = collectPayloads(params.files ?? []);
    if (params.text) {
      const content = Buffer.from(params.text, "utf-8");
      payloads.push({
        fileName: params.textFileName?.trim() || "message.txt",
        content,
        size: content.length,
        fileType: "text/plain",
      });
    }
    if (payloads.length === 0) {
      throw new Error("The given paths contained no files to send.");
    }
    if (payloads.length > MAX_FILES) {
      throw new Error(
        `Refusing to send ${payloads.length} files in one transfer (limit ${MAX_FILES}). Send them in batches.`,
      );
    }

    const target = params.to.trim();
    let peer: Peer;
    const warnings: string[] = [];

    if (looksLikeHost(target)) {
      peer = {
        alias: target,
        host: target,
        port: params.port ?? DEFAULT_PORT,
        protocol: (params.protocol as "http" | "https") ?? "https",
        fingerprint: "",
      };
    } else {
      const seconds = Math.min(Math.max(params.timeoutSeconds ?? 4, 1), 30);
      const outcome = await discoverPeers(config, {
        timeoutMs: seconds * 1000,
        signal,
      });
      warnings.push(...outcome.warnings);

      const found = findPeer(outcome.peers, target);
      if (!found) {
        throw new PeerNotFoundError(target);
      }
      peer = found;
    }

    const result = await sendFiles(config, {
      peer,
      payloads,
      pin: params.pin,
      signal,
    });

    const total = payloads.reduce((sum, payload) => sum + payload.size, 0);
    const text = [
      formatSendResult(result),
      warnings.length > 0 ? `\nNotes:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: [{ type: "text" as const, text }],
      details: {
        target: peer.alias,
        host: peer.host,
        port: peer.port,
        protocol: peer.protocol,
        fileCount: result.files.length,
        okCount: result.files.filter((file) => file.ok).length,
        bytesSent: result.bytesSent,
        totalBytes: total,
        totalSize: formatBytes(total),
      },
    };
  },
};
