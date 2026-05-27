import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as helpers from "../dist/src/helpers.js";

function withOverrides(overrides, fn) {
  const restore = helpers.__testing.setOverrides(overrides);
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

async function withSiteSkill(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ego-browser-site-skills-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const site = join(dir, "learnings", "example");
    await mkdir(join(site, "notes"), { recursive: true });
    await mkdir(join(site, "tools"), { recursive: true });
    await mkdir(join(site, "browser-tools"), { recursive: true });
    await writeFile(join(site, "notes", "overview.md"), "# Example\n");
    await writeFile(join(site, "tools", "page.js"), [
      "export async function getTitle(ctx, args = {}) {",
      "  return { title: `${args.prefix || ''}${await ctx.js('document.title')}` };",
      "}"
    ].join("\n"));
    await writeFile(join(site, "browser-tools", "extract_title.js"), "async function(args) { return { title: args.prefix + document.title }; }\n");
    await writeFile(join(site, "manifest.json"), JSON.stringify({
      id: "example",
      name: "Example",
      domains: ["example.com", "*.example.net"],
      notes: ["notes/overview.md"],
      nodeTools: {
        get_title: {
          description: "Return the current title.",
          path: "tools/page.js",
          callable: "getTitle",
          args: {
            prefix: {
              type: "string",
              required: false,
              description: "Prefix for the title."
            }
          },
          returns: { type: "object", description: "Title payload." }
        }
      },
      browserTools: {
        extract_title: {
          description: "Extract the current title in page context.",
          path: "browser-tools/extract_title.js",
          args: {
            prefix: {
              type: "string",
              required: false,
              description: "Prefix for the title."
            }
          },
          returns: { type: "object", description: "Title payload." }
        }
      }
    }));
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("siteSkillsForUrl matches manifest domains and exposes declared assets", async () => {
  await withSiteSkill(async (dir) => {
    await withOverrides({ agentWorkspace: () => dir }, async () => {
      const matches = await helpers.siteSkillsForUrl("https://app.example.net/path");

      assert.equal(matches.length, 1);
      assert.equal(matches[0].id, "example");
      assert.equal(matches[0].name, "Example");
      assert.deepEqual(matches[0].domains, ["example.com", "*.example.net"]);
      assert.deepEqual(matches[0].notes, [join(dir, "learnings", "example", "notes", "overview.md")]);
      assert.ok(matches[0].nodeTools.get_title);
      assert.ok(matches[0].browserTools.extract_title);
      assert.deepEqual(await helpers.siteSkillsForUrl("https://app.example.com/path"), []);
    });
  });
});

test("site tools receive helper context and browser tools wrap page JavaScript", async () => {
  await withSiteSkill(async (dir) => {
    const jsExpressions = [];
    await withOverrides({
      agentWorkspace: () => dir,
      cdpOverride: async (method, params) => {
        if (method === "Runtime.evaluate") {
          jsExpressions.push(params.expression);
          if (params.expression === "document.title") {
            return { result: { value: "Example" } };
          }
          return { result: { value: { title: "Title: Example" } } };
        }
        return {};
      }
    }, async () => {
      assert.deepEqual(
        await helpers.runSiteTool("example", "get_title", { prefix: "Title: " }),
        { title: "Title: Example" }
      );
      assert.deepEqual(
        await helpers.runSiteBrowserTool("example", "extract_title", { prefix: "Title: " }),
        { title: "Title: Example" }
      );
    });
    assert.ok(jsExpressions.some((expression) => expression.includes("const __egoBrowserTool = async function(args)")));
    assert.ok(jsExpressions.some((expression) => expression.includes('"prefix":"Title: "')));
  });
});

test("missing site skill error includes searched root and workspace hint", async () => {
  await withSiteSkill(async (dir) => {
    await withOverrides({ agentWorkspace: () => dir }, async () => {
      const previous = process.env.EGO_BROWSER_AGENT_WORKSPACE;
      try {
        process.env.EGO_BROWSER_AGENT_WORKSPACE = "/tmp/ego-browser-test-workspace";
        await assert.rejects(
          () => helpers.runSiteTool("missing-site", "noop", {}),
          (error) => {
            assert.match(error.message, /site skill not found: "missing-site"/);
            assert.match(error.message, new RegExp(`searched: .*${join(dir, "learnings").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
            assert.match(error.message, /EGO_BROWSER_AGENT_WORKSPACE: \/tmp\/ego-browser-test-workspace/);
            assert.match(error.message, /hint: ensure your write path begins/);
            return true;
          }
        );
      } finally {
        if (previous === undefined) {
          delete process.env.EGO_BROWSER_AGENT_WORKSPACE;
        } else {
          process.env.EGO_BROWSER_AGENT_WORKSPACE = previous;
        }
      }
    });
  });
});
