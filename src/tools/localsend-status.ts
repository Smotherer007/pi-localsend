/**
 * localsend_status tool -- Show the current settings and this machine's
 * addresses, without opening any socket.
 */

import { Type } from "typebox";
import { getConfig, hasSavedSettings } from "../config.ts";
import { localAddresses } from "../net.ts";
import { isOpensslAvailable } from "../tls.ts";
import { formatStatus } from "../formatting/formatters.ts";

export const LocalSendStatusTool = {
  name: "localsend_status",
  label: "LocalSend Status",
  description:
    "Show the current LocalSend settings, the download directory, and the addresses other devices can reach this machine at. Opens no ports.",
  parameters: Type.Object({}),

  execute(_toolCallId: string, _params: {}, _signal: AbortSignal) {
    const config = getConfig();
    const addresses = localAddresses();
    const httpsAvailable = isOpensslAvailable();

    return {
      content: [
        {
          type: "text" as const,
          text: formatStatus(config, addresses, hasSavedSettings(), httpsAvailable),
        },
      ],
      details: {
        alias: config.alias,
        downloadDir: config.downloadDir,
        protocol: config.protocol,
        requirePin: config.requirePin,
        addresses,
        httpsAvailable,
      },
    };
  },
};
