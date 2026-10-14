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
  it("ships a SKILL.md whose frontmatter is valid YAML", async () => {
    // Parsing it for real rather than pulling fields out with a regular
    // expression: pi loads these with a YAML parser, and an unquoted value
    // containing ": " is read as a nested mapping and rejected. A regex is
    // happy with that, which is exactly how a broken skill shipped once.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { parse } = await import("yaml");

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

      const end = content.indexOf("\n---", 4);
      assert.ok(end > 0, `${name}: the frontmatter is not closed`);

      let frontmatter: Record<string, unknown>;
      try {
        frontmatter = parse(content.slice(4, end)) as Record<string, unknown>;
      } catch (err) {
        assert.fail(`${name}: the frontmatter is not valid YAML -- ${(err as Error).message}`);
      }

      assert.strictEqual(frontmatter.name, name, `${name}: frontmatter name mismatch`);
      assert.match(String(frontmatter.name), /^[a-z0-9-]{1,64}$/);

      const description = frontmatter.description;
      assert.strictEqual(typeof description, "string", `${name}: description must be a string`);
      assert.ok(String(description).length > 0 && String(description).length <= 1024);
    }
  });

  it("catches the mistake that broke a skill once", async () => {
    const { parse } = await import("yaml");
    // An unquoted value with a colon and a space is a nested mapping to YAML.
    assert.throws(
      () => parse("description: Use it on another host: deploy things\n"),
      /mapping/i,
    );
  });
});
