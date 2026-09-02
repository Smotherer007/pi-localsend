import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testHome = path.join(os.tmpdir(), "pi-localsend-cfg-" + Date.now());
const configFile = path.join(testHome, ".pi", "localsend-config.json");
const originalHome = process.env.HOME;

async function freshConfig() {
  const mod = await import("../src/config.ts");
  mod._resetForTesting();
  return mod;
}

describe("config", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(testHome, ".pi"), { recursive: true, mode: 0o700 });
    process.env.HOME = testHome;
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  });

  afterEach(() => {
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
    process.env.HOME = originalHome;
  });

  describe("defaults", () => {
    it("is usable with no saved settings at all", async () => {
      const mod = await freshConfig();
      const config = mod.getConfig();
      assert.ok(config.alias.length > 0);
      assert.ok(config.downloadDir.length > 0);
      assert.strictEqual(config.protocol, "http");
      assert.strictEqual(config.port, 0);
      assert.strictEqual(config.requirePin, true);
    });

    it("reports that nothing was customised", async () => {
      const mod = await freshConfig();
      mod.getConfig();
      assert.strictEqual(mod.hasSavedSettings(), false);
    });

    it("generates a fingerprint once and then keeps it", async () => {
      const mod = await freshConfig();
      const first = mod.getConfig().fingerprint;
      assert.strictEqual(first.length, 64);
      assert.strictEqual(mod.getConfig().fingerprint, first);

      mod._resetForTesting();
      assert.strictEqual(mod.getConfig().fingerprint, first);
    });
  });

  describe("updateConfig", () => {
    it("saves an alias and reports it as customised", async () => {
      const mod = await freshConfig();
      const config = mod.updateConfig({ alias: "  Pats pi  " });
      assert.strictEqual(config.alias, "Pats pi");
      assert.strictEqual(mod.hasSavedSettings(), true);
    });

    it("rejects an empty alias", async () => {
      const mod = await freshConfig();
      assert.throws(() => mod.updateConfig({ alias: "   " }), /must not be empty/);
    });

    it("rejects an over-long alias", async () => {
      const mod = await freshConfig();
      assert.throws(() => mod.updateConfig({ alias: "x".repeat(65) }), /64 characters/);
    });

    it("rejects an unknown deviceType", async () => {
      const mod = await freshConfig();
      assert.throws(() => mod.updateConfig({ deviceType: "toaster" }), /Invalid deviceType/);
    });

    it("accepts the protocol values from the spec", async () => {
      const mod = await freshConfig();
      assert.strictEqual(mod.updateConfig({ protocol: "https" }).protocol, "https");
      assert.throws(() => mod.updateConfig({ protocol: "ftp" as any }), /Invalid protocol/);
    });

    it("rejects a port outside the valid range", async () => {
      const mod = await freshConfig();
      assert.throws(() => mod.updateConfig({ port: 70000 }), /between 0 and 65535/);
      assert.throws(() => mod.updateConfig({ port: -1 }), /between 0 and 65535/);
      assert.strictEqual(mod.updateConfig({ port: 53317 }).port, 53317);
    });

    it("creates the download directory and stores it absolute", async () => {
      const mod = await freshConfig();
      const target = path.join(testHome, "incoming", "nested");
      const config = mod.updateConfig({ downloadDir: target });
      assert.strictEqual(config.downloadDir, target);
      assert.ok(fs.existsSync(target));
    });

    it("expands a tilde in the download directory", async () => {
      const mod = await freshConfig();
      const config = mod.updateConfig({ downloadDir: "~/ls-test-dir" });
      assert.ok(path.isAbsolute(config.downloadDir));
      assert.ok(!config.downloadDir.includes("~"));
      fs.rmSync(config.downloadDir, { recursive: true, force: true });
    });
  });

  describe("persistence", () => {
    it("writes the file with 0600 permissions", async () => {
      const mod = await freshConfig();
      mod.updateConfig({ alias: "Pat" });
      assert.strictEqual(fs.statSync(configFile).mode & 0o777, 0o600);
    });

    it("stores only overrides, not the whole default set", async () => {
      const mod = await freshConfig();
      mod.updateConfig({ alias: "Pat" });
      const stored = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      assert.strictEqual(stored.alias, "Pat");
      assert.strictEqual(stored.downloadDir, undefined);
    });

    it("round-trips through loadConfig", async () => {
      const mod = await freshConfig();
      mod.updateConfig({ alias: "Pat", requirePin: false });
      mod._resetForTesting();
      mod.loadConfig();
      assert.strictEqual(mod.getConfig().alias, "Pat");
      assert.strictEqual(mod.getConfig().requirePin, false);
    });

    it("survives a corrupt config file", async () => {
      fs.writeFileSync(configFile, "{ not json", { mode: 0o600 });
      const mod = await freshConfig();
      mod.loadConfig();
      assert.ok(mod.getConfig().alias.length > 0);
    });

    it("resetConfig clears the overrides", async () => {
      const mod = await freshConfig();
      mod.updateConfig({ alias: "Pat" });
      mod.resetConfig();
      assert.strictEqual(mod.hasSavedSettings(), false);
    });
  });
});
