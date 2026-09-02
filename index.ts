/**
 * pi LocalSend Extension
 *
 * Sends and receives files over the local network using the LocalSend
 * protocol v2.1 (https://github.com/localsend/localsend), so pi can exchange
 * files with phones, tablets and other machines without a cloud service.
 *
 * Tools:
 *   - localsend_setup: Alias, download directory, PIN policy, transport
 *   - localsend_status: Current settings and this machine's addresses
 *   - localsend_devices: Scan the network for LocalSend devices
 *   - localsend_send: Send files or a text snippet to a device
 *   - localsend_receive: Accept exactly one incoming transfer
 *
 * No background service: sockets are open only while one of these tools is
 * running, and every one of them closes what it opened before it returns.
 *
 * Data-oriented design:
 *   - All domain data is represented as plain immutable interfaces (types.ts)
 *   - Protocol I/O lives in clients/ (sending) and server/ (receiving)
 *   - Pure helpers and formatters have no sockets in them (net.ts, formatting/)
 *   - Each tool is a single-responsibility module (tools/)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, getConfig } from "./src/config.ts";
import { LocalSendSetupTool } from "./src/tools/localsend-setup.ts";
import { LocalSendStatusTool } from "./src/tools/localsend-status.ts";
import { LocalSendDevicesTool } from "./src/tools/localsend-devices.ts";
import { LocalSendSendTool } from "./src/tools/localsend-send.ts";
import { LocalSendReceiveTool } from "./src/tools/localsend-receive.ts";

export default function (pi: ExtensionAPI) {
  // Load saved settings on startup
  loadConfig();

  // Register all tools
  pi.registerTool(LocalSendSetupTool);
  pi.registerTool(LocalSendStatusTool);
  pi.registerTool(LocalSendDevicesTool);
  pi.registerTool(LocalSendSendTool);
  pi.registerTool(LocalSendReceiveTool);

  // Look at what is on the network
  pi.registerCommand("localsend", {
    description: "Scan the network for LocalSend devices",
    handler: async (_args, ctx) => {
      pi.sendUserMessage(
        "Use localsend_devices to show which LocalSend devices are reachable on this network right now.",
        { deliverAs: "steer" },
      );
      ctx.ui.notify("Scanning for LocalSend devices...", "info");
    },
  });

  // Open a receive window
  pi.registerCommand("localsend-receive", {
    description: "Wait for one incoming LocalSend transfer",
    handler: async (args, ctx) => {
      const config = getConfig();
      const minutes = Number.parseInt(args.trim(), 10);
      const seconds = Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : 300;

      pi.sendUserMessage(
        `Use localsend_receive with timeoutSeconds ${seconds} to accept one incoming file transfer. Tell me the PIN and the address as soon as the receiver is listening, then report what arrived.`,
        { deliverAs: "steer" },
      );
      ctx.ui.notify(
        `Waiting for one transfer into ${config.downloadDir}...`,
        "info",
      );
    },
  });
}
