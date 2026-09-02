/**
 * localsend_receive tool -- Accept exactly one incoming transfer.
 *
 * The server exists only for the duration of this call: it starts, waits for
 * one session, writes the files and shuts down. There is no daemon and
 * nothing is left listening afterwards.
 */

import { Type } from "typebox";
import { getConfig } from "../config.ts";
import { receiveOnce } from "../server/receive-server.ts";
import { expandPath, formatBytes, generatePin, localAddresses } from "../net.ts";
import { formatListening, formatReceiveResult } from "../formatting/formatters.ts";

/** The shape pi expects from a progress update: a tool result in miniature. */
export interface ToolUpdate {
  readonly content: ReadonlyArray<{ type: "text"; text: string }>;
  readonly details?: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3600;

export const LocalSendReceiveTool = {
  name: "localsend_receive",
  label: "LocalSend Receive",
  description:
    "Wait for one incoming LocalSend transfer and save the files, then shut the receiver down. Blocks until the transfer finishes or the timeout expires. Tell the user the PIN and the address this returns, so they can start the transfer on the sending device.",
  parameters: Type.Object({
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: `How long to wait for a sender. Default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS}.`,
        default: DEFAULT_TIMEOUT_SECONDS,
      }),
    ),
    downloadDir: Type.Optional(
      Type.String({
        description:
          "Where to save the incoming files, just for this transfer. Defaults to the configured download directory.",
      }),
    ),
    pin: Type.Optional(
      Type.String({
        description:
          "Use this PIN instead of a generated one. Ignored when requirePin is off.",
      }),
    ),
    noPin: Type.Optional(
      Type.Boolean({
        description:
          "Accept without a PIN, so any device on the network can send during the window. Default false.",
        default: false,
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: {
      timeoutSeconds?: number;
      downloadDir?: string;
      pin?: string;
      noPin?: boolean;
    },
    signal: AbortSignal,
    onUpdate?: (update: ToolUpdate) => void,
  ) {
    const config = getConfig();
    const seconds = Math.min(
      Math.max(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 5),
      MAX_TIMEOUT_SECONDS,
    );
    const downloadDir = params.downloadDir
      ? expandPath(params.downloadDir)
      : config.downloadDir;

    const usePin = config.requirePin && !params.noPin;
    const pin = usePin ? (params.pin?.trim() || generatePin()) : null;

    // pi renders a progress update as a tool result, so it must have the same
    // shape as one: a `content` array of blocks. Anything else crashes the
    // renderer rather than this tool.
    const report = (text: string, details: Record<string, unknown>) => {
      if (typeof onUpdate !== "function") return;
      try {
        onUpdate({ content: [{ type: "text", text }], details });
      } catch {
        /* progress output is best-effort */
      }
    };

    const arrived: string[] = [];
    const handle = await receiveOnce(config, {
      downloadDir,
      pin,
      timeoutMs: seconds * 1000,
      signal,
      onFile: (file) => {
        arrived.push(file.fileName);
        report(`Received ${file.fileName} (${formatBytes(file.size)}).`, {
          received: [...arrived],
          bytes: file.size,
        });
      },
    });

    const address = {
      port: handle.port,
      protocol: handle.protocol,
      addresses: localAddresses(),
    };
    const banner = formatListening(address, pin, seconds);

    // The PIN is useless once the call returns, so push it out while the
    // receiver is still waiting.
    report(banner, {
      listening: true,
      port: handle.port,
      protocol: handle.protocol,
      pinUsed: Boolean(pin),
    });

    const result = await handle.done;

    const text = [
      banner,
      "",
      formatReceiveResult(result, downloadDir),
      handle.warnings.length > 0
        ? `\nNotes:\n${handle.warnings.map((warning) => `- ${warning}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: [{ type: "text" as const, text }],
      details: {
        outcome: result.outcome,
        fileCount: result.files.length,
        bytesReceived: result.bytesReceived,
        files: result.files.map((file) => file.path),
        downloadDir,
        port: handle.port,
        protocol: handle.protocol,
        pinUsed: Boolean(pin),
        sender: result.sender?.alias,
      },
    };
  },
};
