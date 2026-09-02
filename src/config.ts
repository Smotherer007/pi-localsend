/**
 * Configuration persistence and state.
 *
 * Unlike an account-based integration, LocalSend needs no credentials, so
 * every setting has a working default and the extension is usable without
 * calling localsend_setup at all. Setup only persists overrides, in
 * ~/.pi/localsend-config.json.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LocalSendConfig } from "./types.ts";
import { DEFAULT_PORT } from "./types.ts";
import { expandPath, randomFingerprint } from "./net.ts";

const VALID_DEVICE_TYPES = new Set([
  "mobile",
  "desktop",
  "web",
  "headless",
  "server",
]);

let overrides: Partial<LocalSendConfig> = {};
let loaded = false;

function configPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".pi", "localsend-config.json");
}

/** ~/Downloads if it exists, otherwise the home directory. */
function defaultDownloadDir(): string {
  const downloads = path.join(os.homedir(), "Downloads");
  return fs.existsSync(downloads) ? downloads : os.homedir();
}

function defaultAlias(): string {
  const host = os.hostname().replace(/\.local$/i, "").trim();
  return host ? `pi on ${host}` : "pi";
}

function defaults(): LocalSendConfig {
  return {
    alias: defaultAlias(),
    deviceModel: `${os.type()} ${os.release()}`.trim(),
    deviceType: "desktop",
    downloadDir: defaultDownloadDir(),
    protocol: "http",
    // 0 means "pick a free port": the LocalSend app may already own 53317,
    // and the port we listen on is advertised in the announcement anyway.
    port: 0,
    requirePin: true,
    fingerprint: "",
  };
}

function persist(): void {
  const filePath = configPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(overrides, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function loadConfig(): void {
  loaded = true;
  try {
    const filePath = configPath();
    if (!fs.existsSync(filePath)) {
      overrides = {};
      return;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    overrides = raw && typeof raw === "object" ? raw : {};
  } catch {
    overrides = {};
  }
}

/**
 * The effective settings: defaults with any saved overrides applied. The
 * fingerprint is generated once and persisted, so peers keep recognising
 * this device across sessions.
 */
export function getConfig(): LocalSendConfig {
  if (!loaded) loadConfig();

  const config = { ...defaults(), ...overrides } as LocalSendConfig;

  if (!config.fingerprint) {
    const fingerprint = randomFingerprint();
    overrides = { ...overrides, fingerprint };
    try {
      persist();
    } catch {
      /* an unwritable config must not stop a transfer */
    }
    return { ...config, fingerprint };
  }
  return config;
}

/** True when the user has saved any setting of their own. */
export function hasSavedSettings(): boolean {
  if (!loaded) loadConfig();
  return Object.keys(overrides).filter((key) => key !== "fingerprint").length > 0;
}

export function updateConfig(patch: Partial<LocalSendConfig>): LocalSendConfig {
  if (!loaded) loadConfig();

  const next: Partial<LocalSendConfig> = { ...overrides };

  if (patch.alias !== undefined) {
    const alias = patch.alias.trim();
    if (!alias) throw new Error("alias must not be empty.");
    if (alias.length > 64) throw new Error("alias must be 64 characters or fewer.");
    next.alias = alias;
  }
  if (patch.deviceModel !== undefined) next.deviceModel = patch.deviceModel.trim();
  if (patch.deviceType !== undefined) {
    if (!VALID_DEVICE_TYPES.has(patch.deviceType)) {
      throw new Error(
        `Invalid deviceType "${patch.deviceType}". Use one of: ${[...VALID_DEVICE_TYPES].join(", ")}.`,
      );
    }
    next.deviceType = patch.deviceType;
  }
  if (patch.downloadDir !== undefined) {
    const dir = expandPath(patch.downloadDir);
    fs.mkdirSync(dir, { recursive: true });
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      throw new Error(`downloadDir "${dir}" is not a directory.`);
    }
    next.downloadDir = dir;
  }
  if (patch.protocol !== undefined) {
    if (patch.protocol !== "http" && patch.protocol !== "https") {
      throw new Error(`Invalid protocol "${patch.protocol}". Use http or https.`);
    }
    next.protocol = patch.protocol;
  }
  if (patch.port !== undefined) {
    if (!Number.isInteger(patch.port) || patch.port < 0 || patch.port > 65535) {
      throw new Error("port must be an integer between 0 and 65535 (0 = pick a free one).");
    }
    next.port = patch.port;
  }
  if (patch.requirePin !== undefined) next.requirePin = patch.requirePin;

  overrides = next;
  persist();
  return getConfig();
}

export function resetConfig(): void {
  overrides = {};
  persist();
}

export { DEFAULT_PORT };

/** @internal Reset in-memory state -- for testing only */
export function _resetForTesting(): void {
  overrides = {};
  loaded = false;
}
