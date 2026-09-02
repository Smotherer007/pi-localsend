/**
 * Data types for the pi LocalSend extension.
 *
 * Mirrors the LocalSend protocol v2.1 wire format where it crosses the
 * network, and keeps everything else as plain immutable-shaped interfaces.
 */

// Protocol constants

export const MULTICAST_ADDRESS = "224.0.0.167";
export const DEFAULT_PORT = 53317;
export const PROTOCOL_VERSION = "2.1";
export const API_PREFIX = "/api/localsend/v2";

// Configuration

export interface LocalSendConfig {
  /** Name other devices see in their device list. */
  readonly alias: string;
  /** Free-text model shown next to the alias, e.g. "MacBook Pro". */
  readonly deviceModel?: string;
  /** One of: mobile, desktop, web, headless, server. */
  readonly deviceType: string;
  /** Directory incoming files are written to. */
  readonly downloadDir: string;
  /** Preferred transport. "https" needs a certificate; falls back to http. */
  readonly protocol: "http" | "https";
  /** Port to listen on. 0 picks a free one, which avoids clashing with the app. */
  readonly port: number;
  /** Require a PIN for incoming transfers. Defaults to true. */
  readonly requirePin: boolean;
  /** Stable per-installation id when running unencrypted. */
  readonly fingerprint: string;
}

// Wire format -- device announcements and registrations

export interface DeviceInfo {
  readonly alias: string;
  readonly version: string;
  readonly deviceModel?: string;
  readonly deviceType?: string;
  readonly fingerprint: string;
  readonly port?: number;
  readonly protocol?: string;
  readonly download?: boolean;
  readonly announce?: boolean;
}

/** A device found on the network, with the address we reached it at. */
export interface Peer {
  readonly alias: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: "http" | "https";
  readonly fingerprint: string;
  readonly deviceModel?: string;
  readonly deviceType?: string;
  readonly download?: boolean;
}

// Wire format -- transfers

export interface FileMetadata {
  readonly modified?: string;
  readonly accessed?: string;
}

export interface FileDescriptor {
  readonly id: string;
  readonly fileName: string;
  readonly size: number;
  readonly fileType: string;
  readonly sha256?: string;
  readonly preview?: string;
  readonly metadata?: FileMetadata;
}

export interface PrepareUploadRequest {
  readonly info: DeviceInfo;
  readonly files: Record<string, FileDescriptor>;
}

export interface PrepareUploadResponse {
  readonly sessionId: string;
  readonly files: Record<string, string>;
}

// Results

export interface SentFile {
  readonly fileName: string;
  readonly size: number;
  readonly ok: boolean;
  readonly error?: string;
}

export interface SendResult {
  readonly peer: Peer;
  readonly sessionId: string;
  readonly files: ReadonlyArray<SentFile>;
  readonly bytesSent: number;
}

export interface ReceivedFile {
  readonly fileName: string;
  readonly path: string;
  readonly size: number;
}

export interface ReceiveResult {
  readonly files: ReadonlyArray<ReceivedFile>;
  readonly sender?: DeviceInfo;
  readonly senderAddress?: string;
  readonly bytesReceived: number;
  /** Why the receiver stopped: the transfer finished, timed out or was cancelled. */
  readonly outcome: "completed" | "timeout" | "cancelled";
}

export interface ListenerAddress {
  readonly port: number;
  readonly protocol: "http" | "https";
  /** Addresses a peer on the LAN can reach this machine at. */
  readonly addresses: ReadonlyArray<string>;
}

// Errors

export class LocalSendNotConfiguredError extends Error {
  constructor() {
    super(
      "LocalSend is not configured. Use the localsend_setup tool first (alias and download directory).",
    );
    this.name = "LocalSendNotConfiguredError";
  }
}

export class PeerNotFoundError extends Error {
  constructor(name: string) {
    super(
      `No LocalSend device called "${name}" answered. Run localsend_devices to see what is on the network, and make sure the other device has LocalSend open.`,
    );
    this.name = "PeerNotFoundError";
  }
}

export class TransferRejectedError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TransferRejectedError";
    this.status = status;
  }
}

export class UnsafeFileNameError extends Error {
  constructor(fileName: string) {
    super(`Refusing to write a file with an unsafe name: ${fileName}`);
    this.name = "UnsafeFileNameError";
  }
}
