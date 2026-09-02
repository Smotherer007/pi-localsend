/**
 * Smoke test -- tool shapes, extension registration, and the skill manifest.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LocalSendSetupTool } from "../src/tools/localsend-setup.ts";
import { LocalSendStatusTool } from "../src/tools/localsend-status.ts";
import { LocalSendDevicesTool } from "../src/tools/localsend-devices.ts";
import { LocalSendSendTool } from "../src/tools/localsend-send.ts";
import { LocalSendReceiveTool } from "../src/tools/localsend-receive.ts";

const allTools = [
  LocalSendSetupTool,
  LocalSendStatusTool,
  LocalSendDevicesTool,
  LocalSendSendTool,
  LocalSendReceiveTool,
];

describe("Tool structure smoke test", () => {
  it("has exactly 5 tools", () => {
    assert.strictEqual(allTools.length, 5);
  });

  for (const tool of allTools) {
    it(`${tool.name} has required fields`, () => {
      assert.ok(tool.name);
      assert.strictEqual(typeof tool.name, "string");
      assert.ok(tool.label);
      assert.ok(tool.description);
      assert.ok(tool.parameters !== undefined);
      assert.strictEqual(typeof tool.execute, "function");
    });
  }

  it("all tool names are unique", () => {
    const names = allTools.map((tool) => tool.name);
    assert.strictEqual(new Set(names).size, names.length);
  });

  it("all tool names follow the localsend_ prefix convention", () => {
    for (const tool of allTools) {
      assert.ok(/^localsend_/.test(tool.name), `${tool.name} lacks the prefix`);
    }
  });

  it("every description explains when to use the tool", () => {
    for (const tool of allTools) {
      assert.ok(tool.description.length > 40, `${tool.name} is too terse`);
    }
  });
});

describe("Extension entry point", () => {
  it("registers every tool and command without errors", async () => {
    const registered: string[] = [];
    const commands: string[] = [];
    const mod = await import("../index.ts");

    mod.default({
      registerTool: (tool: { name: string }) => registered.push(tool.name),
      registerCommand: (name: string) => commands.push(name),
      sendUserMessage: () => {},
    } as any);

    assert.deepStrictEqual(registered.sort(), allTools.map((t) => t.name).sort());
    assert.deepStrictEqual(commands.sort(), ["localsend", "localsend-receive"]);
  });
});

describe("Skills", () => {
  it("ships a SKILL.md with valid frontmatter for every skill", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const skillsDir = path.join(import.meta.dirname, "..", "skills");
    const names = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    assert.ok(names.length >= 1);

    for (const name of names) {
      const file = path.join(skillsDir, name, "SKILL.md");
      assert.ok(fs.existsSync(file), `${name} has no SKILL.md`);

      const content = fs.readFileSync(file, "utf-8");
      assert.ok(content.startsWith("---\n"), `${name} has no frontmatter`);

      const frontmatter = content.slice(4, content.indexOf("\n---", 4));
      const declaredName = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
      const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();

      assert.strictEqual(declaredName, name, `${name}: frontmatter name mismatch`);
      assert.match(declaredName!, /^[a-z0-9-]{1,64}$/);
      assert.ok(description && description.length <= 1024);
    }
  });
});
