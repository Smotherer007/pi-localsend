/**
 * Sending to a receiver that asks for a client certificate.
 *
 * This is what the LocalSend app does: its TLS server requests a certificate
 * from the sender, and identifies the sender by that certificate's SHA-256,
 * which it checks against the fingerprint in the prepare-upload body. A
 * client that presents nothing never gets past the handshake -- the server
 * answers with a "certificate required" alert (TLS alert 116).
 *
 * The receiver in this package does not request client certificates, so
 * without this test the requirement would go unexercised.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as https from "node:https";
import type { AddressInfo } from "node:net";

import { sendFiles } from "../src/clients/send-client.ts";
import { ensureTlsMaterial } from "../src/tls.ts";
import { API_PREFIX, type LocalSendConfig, type Peer } from "../src/types.ts";

const material = ensureTlsMaterial();

const config: LocalSendConfig = {
  alias: "pi sender",
  deviceType: "headless",
  downloadDir: "/tmp",
  protocol: "http", // deliberately http: sending to an https peer must still work
  port: 0,
  requirePin: false,
  fingerprint: "an-unrelated-http-fingerprint",
};

describe("sending to a peer that requires a client certificate", () => {
  let server: https.Server;
  let port = 0;
  let presentedCertSha: string | null = null;
  let announcedFingerprint: string | null = null;
  let uploadedBody = "";

  before(async () => {
    if (!material) return;

    server = https.createServer(
      {
        cert: material.cert,
        key: material.key,
        // What the LocalSend receiver does: ask for the sender's certificate,
        // without demanding a CA chain, because everything is self-signed.
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => {
        const peerCert = (req.socket as any).getPeerCertificate?.();
        if (peerCert && peerCert.raw && peerCert.raw.length > 0) {
          presentedCertSha = crypto.createHash("sha256").update(peerCert.raw).digest("hex");
        }

        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks);

          if (req.url?.startsWith(`${API_PREFIX}/prepare-upload`)) {
            const parsed = JSON.parse(body.toString("utf-8"));
            announcedFingerprint = parsed.info?.fingerprint ?? null;
            const fileId = Object.keys(parsed.files)[0];
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessionId: "s1", files: { [fileId]: "token-1" } }));
            return;
          }

          if (req.url?.startsWith(`${API_PREFIX}/upload`)) {
            uploadedBody = body.toString("utf-8");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            return;
          }

          res.writeHead(404);
          res.end("{}");
        });
      },
    );

    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("completes the handshake by presenting a certificate", async (t) => {
    if (!material) {
      t.skip("openssl unavailable, so no client certificate can be made");
      return;
    }

    const peer: Peer = {
      alias: "iPhone",
      host: "127.0.0.1",
      port,
      protocol: "https",
      fingerprint: "peer-fp",
    };

    const result = await sendFiles(config, {
      peer,
      payloads: [{ fileName: "hello.txt", content: Buffer.from("hi"), size: 2 }],
    });

    assert.strictEqual(result.files[0].ok, true);
    assert.strictEqual(uploadedBody, "hi");
    assert.ok(presentedCertSha, "the receiver saw no client certificate");
  });

  it("announces the fingerprint of the certificate it presented", async (t) => {
    if (!material) {
      t.skip("openssl unavailable");
      return;
    }

    // The receiver checks the announced fingerprint against the certificate,
    // so the http-mode random id must not be sent over a TLS connection.
    assert.strictEqual(announcedFingerprint, presentedCertSha);
    assert.strictEqual(announcedFingerprint, material.fingerprint);
    assert.notStrictEqual(announcedFingerprint, config.fingerprint);
  });
});
