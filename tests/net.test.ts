import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  constantTimeEquals,
  expandPath,
  formatBytes,
  generatePin,
  guessFileType,
  localAddresses,
  randomFingerprint,
  safeFileName,
  uniquePath,
} from "../src/net.ts";

describe("safeFileName", () => {
  it("keeps an ordinary name", () => {
    assert.strictEqual(safeFileName("report.pdf"), "report.pdf");
  });

  it("strips a POSIX traversal attempt", () => {
    assert.strictEqual(safeFileName("../../etc/passwd"), "passwd");
  });

  it("strips a Windows path", () => {
    assert.strictEqual(safeFileName("C:\\Users\\pat\\evil.exe"), "evil.exe");
  });

  it("strips mixed separators", () => {
    assert.strictEqual(safeFileName("..\\../secret/../x.txt"), "x.txt");
  });

  it("removes control characters", () => {
    assert.strictEqual(safeFileName("a\u0000b\u001fc.txt"), "abc.txt");
  });

  it("rejects a name that is only dots", () => {
    assert.throws(() => safeFileName(".."), /unsafe name/);
    assert.throws(() => safeFileName("..."), /unsafe name/);
  });

  it("rejects an empty name", () => {
    assert.throws(() => safeFileName(""), /unsafe name/);
    assert.throws(() => safeFileName("/"), /unsafe name/);
  });

  it("keeps a legitimate dotfile", () => {
    assert.strictEqual(safeFileName(".gitignore"), ".gitignore");
  });

  it("caps an absurdly long name but keeps the extension", () => {
    const result = safeFileName("a".repeat(500) + ".txt");
    assert.ok(result.length <= 200);
    assert.ok(result.endsWith(".txt"));
  });
});

describe("uniquePath", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-unique-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the plain path when nothing is there", () => {
    assert.strictEqual(uniquePath(dir, "a.txt"), path.join(dir, "a.txt"));
  });

  it("never overwrites an existing file", () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    assert.strictEqual(uniquePath(dir, "a.txt"), path.join(dir, "a (2).txt"));
  });

  it("keeps counting past the first collision", () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    fs.writeFileSync(path.join(dir, "a (2).txt"), "x");
    assert.strictEqual(uniquePath(dir, "a.txt"), path.join(dir, "a (3).txt"));
  });

  it("contains a traversal attempt inside the directory", () => {
    const resolved = uniquePath(dir, "../../escape.txt");
    assert.strictEqual(resolved, path.join(dir, "escape.txt"));
  });

  it("handles a name with no extension", () => {
    fs.writeFileSync(path.join(dir, "README"), "x");
    assert.strictEqual(uniquePath(dir, "README"), path.join(dir, "README (2)"));
  });
});

describe("guessFileType", () => {
  it("maps common extensions", () => {
    assert.strictEqual(guessFileType("a.png"), "image/png");
    assert.strictEqual(guessFileType("a.PDF"), "application/pdf");
    assert.strictEqual(guessFileType("a.txt"), "text/plain");
  });

  it("falls back to a byte stream", () => {
    assert.strictEqual(guessFileType("a.unknownext"), "application/octet-stream");
    assert.strictEqual(guessFileType("noextension"), "application/octet-stream");
  });
});

describe("formatBytes", () => {
  it("formats each magnitude", () => {
    assert.strictEqual(formatBytes(0), "0 B");
    assert.strictEqual(formatBytes(512), "512 B");
    assert.strictEqual(formatBytes(1536), "1.5 KB");
    assert.strictEqual(formatBytes(1024 * 1024 * 5), "5.0 MB");
  });

  it("handles nonsense input", () => {
    assert.strictEqual(formatBytes(-1), "unknown size");
    assert.strictEqual(formatBytes(Number.NaN), "unknown size");
  });
});

describe("constantTimeEquals", () => {
  it("matches equal strings", () => {
    assert.strictEqual(constantTimeEquals("123456", "123456"), true);
  });

  it("rejects different strings of the same length", () => {
    assert.strictEqual(constantTimeEquals("123456", "123457"), false);
  });

  it("rejects different lengths without throwing", () => {
    assert.strictEqual(constantTimeEquals("123", "123456"), false);
  });

  it("handles nullish input", () => {
    assert.strictEqual(constantTimeEquals("", ""), true);
    assert.strictEqual(constantTimeEquals(undefined as any, "x"), false);
  });
});

describe("identifiers", () => {
  it("generates a six digit PIN", () => {
    for (let i = 0; i < 50; i += 1) {
      assert.match(generatePin(), /^\d{6}$/);
    }
  });

  it("generates distinct fingerprints", () => {
    assert.notStrictEqual(randomFingerprint(), randomFingerprint());
    assert.strictEqual(randomFingerprint().length, 64);
  });
});

describe("expandPath", () => {
  it("expands a leading tilde", () => {
    assert.strictEqual(expandPath("~"), os.homedir());
    assert.strictEqual(expandPath("~/Downloads"), path.join(os.homedir(), "Downloads"));
  });

  it("resolves a relative path to absolute", () => {
    assert.ok(path.isAbsolute(expandPath("./somewhere")));
  });
});

describe("localAddresses", () => {
  it("returns only non-internal IPv4 addresses", () => {
    for (const address of localAddresses()) {
      assert.match(address, /^\d{1,3}(\.\d{1,3}){3}$/);
      assert.notStrictEqual(address, "127.0.0.1");
    }
  });
});
