/**
 * localsend_setup tool -- Persist the settings other devices see.
 *
 * Everything has a working default, so this is optional: it only saves
 * overrides to ~/.pi/localsend-config.json.
 */

import { Type } from "typebox";
import { updateConfig } from "../config.ts";
import { localAddresses } from "../net.ts";
import { isOpensslAvailable } from "../tls.ts";
import { formatStatus } from "../formatting/formatters.ts";
import type { LocalSendConfig } from "../types.ts";

export const LocalSendSetupTool = {
  name: "localsend_setup",
  label: "LocalSend Setup",
  description:
    "Change the LocalSend settings: the alias other devices see, where incoming files are saved, whether a PIN is required, and the transport. Optional -- every setting has a working default, so files can be sent and received without calling this first.",
  parameters: Type.Object({
    alias: Type.Optional(
      Type.String({
        description: "Name shown in other devices' LocalSend list, e.g. 'Pat's pi'.",
      }),
    ),
    downloadDir: Type.Optional(
      Type.String({
        description:
          "Directory incoming files are written to. Created if missing. Defaults to ~/Downloads.",
      }),
    ),
    deviceModel: Type.Optional(
      Type.String({ description: "Free-text model shown next to the alias." }),
    ),
    deviceType: Type.Optional(
      Type.String({
        description: "One of: mobile, desktop, web, headless, server. Defaults to desktop.",
      }),
    ),
    protocol: Type.Optional(
      Type.String({
        description:
          "http (default, no dependencies) or https (needs openssl on this machine; falls back to http if unavailable).",
      }),
    ),
    port: Type.Optional(
      Type.Number({
        description:
          "Port to listen on during a transfer. 0 (default) picks a free one, which avoids clashing with the LocalSend desktop app on 53317.",
      }),
    ),
    requirePin: Type.Optional(
      Type.Boolean({
        description:
          "Require a PIN for incoming transfers. Defaults to true; turning it off lets any device on the network send during a receive window.",
      }),
    ),
  }),

  execute(
    _toolCallId: string,
    params: Partial<LocalSendConfig>,
    _signal: AbortSignal,
  ) {
    const config = updateConfig(params);
    return {
      content: [
        {
          type: "text" as const,
          text: `LocalSend settings saved.\n\n${formatStatus(config, localAddresses(), true, isOpensslAvailable())}`,
        },
      ],
      details: {
        alias: config.alias,
        downloadDir: config.downloadDir,
        protocol: config.protocol,
        requirePin: config.requirePin,
      },
    };
  },
};
