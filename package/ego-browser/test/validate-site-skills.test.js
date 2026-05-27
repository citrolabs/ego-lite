import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateSiteSkills } from "../dist/scripts/validate-site-skills.js";

function nodeToolSchema() {
  return {
    get_title: {
      description: "Return the current title.",
      path: "tools/page.js",
      callable: "getTitle",
      args: {},
      returns: { type: "object", description: "Title payload." }
    }
  };
}

function browserToolSchema() {
  return {
    extract_title: {
      description: "Extract the current title.",
      path: "browser-tools/extract_title.js",
      args: {},
      returns: { type: "object", description: "Title payload." }
    }
  };
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "ego-browser-validate-skills-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedSite(root, options = {}) {
  const siteId = options.siteId || "example";
  const site = join(root, siteId);
  await mkdir(join(site, "notes"), { recursive: true });
  await mkdir(join(site, "tools"), { recursive: true });
  await mkdir(join(site, "browser-tools"), { recursive: true });
  const manifest = {
    id: siteId,
    name: "Example",
    domains: ["example.com", "*.example.com"],
    notes: ["notes/overview.md"],
    nodeTools: nodeToolSchema(),
    browserTools: browserToolSchema(),
    ...(options.manifestExtra || {})
  };
  await writeFile(join(site, "manifest.json"), JSON.stringify(manifest));
  if (options.note !== false) {
    await writeFile(join(site, "notes", "overview.md"), options.noteText || "# Example\n");
  }
  if (options.nodeTool !== false) {
    await writeFile(join(site, "tools", "page.js"), options.nodeToolText || "export async function getTitle(ctx) { return ctx.js('document.title'); }\n");
  }
  if (options.browserTool !== false) {
    await writeFile(join(site, "browser-tools", "extract_title.js"), options.browserToolText || "async function(args) { return document.title; }\n");
  }
  return site;
}

test("validateSiteSkills accepts valid sites and ignores _template", async () => {
  await withRoot(async (root) => {
    await seedSite(root);
    await mkdir(join(root, "_template"));

    assert.deepEqual(await validateSiteSkills(root), []);
  });
});

test("validateSiteSkills reports manifest, domain, path, callable, and ref errors", async () => {
  await withRoot(async (root) => {
    await seedSite(root, {
      siteId: "bad",
      manifestExtra: {
        id: "wrong",
        domains: ["https://example.com"],
        notes: ["notes/overview.md", "overview.md"],
        nodeTools: {
          broken: {
            description: "Broken.",
            path: "tools/missing.js",
            callable: "missing",
            args: {
              limit: {
                type: "date",
                required: false,
                description: "Bad type."
              }
            },
            returns: { type: "object", description: "Payload." }
          }
        },
        browserTools: {
          nested: {
            description: "Nested.",
            path: "browser-tools/search/extract.js",
            args: {},
            returns: { type: "array", description: "Rows." }
          }
        }
      },
      noteText: "Do not use @42 here.\n"
    });

    const errors = await validateSiteSkills(root);

    assert.ok(errors.some((error) => error.includes("manifest id must match directory name")));
    assert.ok(errors.some((error) => error.includes("invalid domain")));
    assert.ok(errors.some((error) => error.includes("notes must point to notes/*.md")));
    assert.ok(errors.some((error) => error.includes("path must be a relative tools/*.js path")) || errors.some((error) => error.includes("missing Node tool file")));
    assert.ok(errors.some((error) => error.includes("invalid arg type")));
    assert.ok(errors.some((error) => error.includes("path must be a relative browser-tools/*.js path")));
    assert.ok(errors.some((error) => error.includes("temporary snapshot ref")));
  });
});

test("validateSiteSkills reports missing Node callable", async () => {
  await withRoot(async (root) => {
    await seedSite(root, {
      nodeToolText: "export async function other(ctx) { return ctx.js('document.title'); }\n"
    });

    const errors = await validateSiteSkills(root);

    assert.ok(errors.some((error) => error.includes("missing Node callable")));
  });
});
