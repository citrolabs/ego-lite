#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const TARGETS = [
  {
    id: "claude-code",
    title: "Claude Code",
    files: [".claude-plugin/plugin.json"],
  },
  {
    id: "codex",
    title: "Codex",
    files: [".codex-plugin/plugin.json"],
    marketplace: ".agents/plugins/marketplace.json",
  },
  { id: "cursor", title: "Cursor", files: [".cursor-plugin/plugin.json"] },
  {
    id: "github-copilot",
    title: "GitHub Copilot",
    files: [".claude-plugin/plugin.json"],
  },
  { id: "grok-build", title: "Grok Build", files: [] },
  {
    id: "workbuddy",
    title: "WorkBuddy",
    files: [
      ".claude-plugin/plugin.json",
      ".codebuddy-plugin/plugin.json",
      ".workbuddy-plugin/plugin.json",
    ],
    marketplace: ".claude-plugin/marketplace.json",
  },
  {
    id: "qwenwork",
    title: "QwenWork Desktop",
    files: [".claude-plugin/plugin.json"],
  },
  { id: "opencode", title: "OpenCode", files: ["index.js"], npm: true },
  {
    id: "deepseek-harness",
    title: "DeepSeek Harness",
    files: ["cordis.patch.yml", "dsh/src/index.js"],
    npm: true,
  },
];

function usage() {
  return `Usage:
  node plugins/scripts/package-plugins.mjs <plugin> [--output <directory>]
  node plugins/scripts/package-plugins.mjs --all [--output <directory>]

Builds nine host artifacts per plugin (seven ZIPs and two npm archives).`;
}

function parseArguments(args) {
  let all = false;
  let output;
  let plugin;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--all") {
      all = true;
    } else if (argument === "--output") {
      output = args[index + 1];
      if (!output) throw new Error("--output requires a directory");
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      return { help: true };
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (plugin) {
      throw new Error("Choose one plugin or --all");
    } else {
      plugin = argument;
    }
  }

  if (all && plugin) throw new Error("Choose either one plugin or --all");
  if (!all && !plugin) throw new Error(usage());
  return { all, output, plugin };
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function findRepositoryRoot(start) {
  let directory = resolve(start);
  while (true) {
    if (
      (await isDirectory(join(directory, "plugins"))) &&
      (await isDirectory(join(directory, "skills")))
    ) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Could not find a repository with plugins/ and skills/");
    }
    directory = parent;
  }
}

async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await canonicalPath(parent), basename(path));
  }
}

async function validateLinks(root, label, allowedLinks = new Map()) {
  const information = await lstat(root);
  if (information.isSymbolicLink()) {
    const canonical = allowedLinks.get(root);
    if (canonical && (await canonicalPath(root)) === canonical) return;
    throw new Error(`${label} contains a symbolic link: ${root}`);
  }
  if (!information.isDirectory()) return;

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    await validateLinks(join(root, entry.name), label, allowedLinks);
  }
}

async function pluginNames(repositoryRoot) {
  const entries = await readdir(join(repositoryRoot, "plugins"), {
    withFileTypes: true,
  });
  const names = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await isDirectory(join(repositoryRoot, "plugins", entry.name)))
    ) {
      try {
        await readFile(
          join(repositoryRoot, "plugins", entry.name, "plugin.json"),
          "utf8",
        );
        names.push(entry.name);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return names.sort();
}

async function collectSkills(repositoryRoot, pluginRoot) {
  const packagedSkillsRoot = join(pluginRoot, "skills");
  if (!(await isDirectory(packagedSkillsRoot))) {
    throw new Error(`Plugin has no skills directory: ${pluginRoot}`);
  }

  const entries = await readdir(packagedSkillsRoot, { withFileTypes: true });
  const skills = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();
  if (skills.length === 0) {
    throw new Error(`Plugin has no packaged Skills: ${pluginRoot}`);
  }

  const allowedLinks = new Map();
  for (const skill of skills) {
    const canonical = join(repositoryRoot, "skills", skill);
    if (!(await isDirectory(canonical))) {
      throw new Error(`Canonical Skill not found: skills/${skill}`);
    }
    if ((await realpath(canonical)) !== canonical) {
      throw new Error(`Canonical Skill ${skill} contains a symbolic link`);
    }
    await validateLinks(canonical, `Canonical Skill ${skill}`);
    allowedLinks.set(join(packagedSkillsRoot, skill), canonical);
  }
  await validateLinks(
    pluginRoot,
    `Plugin ${basename(pluginRoot)}`,
    allowedLinks,
  );
  return skills;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) {
    throw new Error(`${command} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${command} failed${details ? `: ${details}` : ""}`);
  }
  return result.stdout;
}

function readmeSection(readme, heading) {
  const section = readme
    .split(`${heading}\n`)[1]
    ?.split(/\n#{1,3} /)[0]
    ?.trim();
  if (!section) throw new Error(`Plugin README.md requires ${heading}`);
  return section;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function packagePlugin(repositoryRoot, name, outputRoot) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(`Invalid plugin name: ${name}`);
  }
  const pluginRoot = join(repositoryRoot, "plugins", name);
  if (!(await isDirectory(pluginRoot))) {
    throw new Error(`Unknown plugin: ${name}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(join(pluginRoot, "plugin.json"), "utf8"),
    );
  } catch (error) {
    throw new Error(`Invalid plugin.json for ${name}: ${error.message}`);
  }
  if (manifest.name !== name) {
    throw new Error(
      `Plugin directory ${name} does not match manifest name ${manifest.name}`,
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.version ?? "")) {
    throw new Error(`Plugin ${name} has an invalid version`);
  }

  const skills = await collectSkills(repositoryRoot, pluginRoot);
  const readme = await readFile(join(pluginRoot, "README.md"), "utf8");
  const requirements = readmeSection(readme, "## Requirements");
  const sourcePackage = JSON.parse(
    await readFile(join(pluginRoot, "package.json"), "utf8"),
  );
  if (sourcePackage.version !== manifest.version) {
    throw new Error(
      `Plugin ${name} package.json version does not match plugin.json`,
    );
  }
  await mkdir(outputRoot, { recursive: true });
  const temporaryRoot = await mkdtemp(join(outputRoot, `.${name}-package-`));
  const releaseRoot = join(outputRoot, `${name}-v${manifest.version}`);
  const archives = [];
  try {
    for (const target of TARGETS) {
      const stagingRoot = join(temporaryRoot, target.id);
      const payloadRoot = target.marketplace
        ? join(stagingRoot, "plugins", name)
        : stagingRoot;
      const entries = [
        "LICENSE",
        ...target.files,
        ...(target.npm ? [] : ["plugin.json"]),
      ];
      for (const entry of entries) {
        const destination = join(payloadRoot, entry);
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(pluginRoot, entry), destination, {
          preserveTimestamps: true,
        });
      }
      for (const skill of skills) {
        const destination = join(payloadRoot, "skills", skill);
        await cp(join(repositoryRoot, "skills", skill), destination, {
          recursive: true,
          preserveTimestamps: true,
        });
        await readFile(join(destination, "SKILL.md"), "utf8");
      }
      const installation = readmeSection(readme, `### ${target.title}`);
      const hostReadme = `# ${name} for ${target.title}\n\n## Requirements\n\n${requirements}\n\n## Installation\n\n${installation}\n`;
      await writeFile(join(payloadRoot, "README.md"), hostReadme);
      if (target.marketplace) {
        const source = `./plugins/${name}`;
        const catalog =
          target.id === "codex"
            ? {
                interface: { displayName: `${name} for ${target.title}` },
                plugins: [
                  {
                    name,
                    source: { source: "local", path: source },
                    policy: {
                      installation: "AVAILABLE",
                      authentication: "ON_INSTALL",
                    },
                    category: "Productivity",
                  },
                ],
              }
            : {
                description: manifest.description,
                owner: manifest.author,
                metadata: { version: manifest.version },
                plugins: [
                  {
                    name,
                    version: manifest.version,
                    description: manifest.description,
                    source,
                  },
                ],
              };
        await writeJson(join(stagingRoot, target.marketplace), {
          name: `${name}-${target.id}-local`,
          ...catalog,
        });
        await writeFile(join(stagingRoot, "README.md"), hostReadme);
      }
      const archiveName = `${name}-${target.id}-v${manifest.version}.${target.npm ? "tgz" : "zip"}`;
      const archive = join(temporaryRoot, archiveName);
      if (target.npm) {
        const pkg = {
          ...sourcePackage,
          name: `${sourcePackage.name}-${target.id}`,
          files: ["LICENSE", "README.md", "skills", ...target.files],
          exports:
            target.id === "opencode"
              ? { ".": "./index.js", "./server": "./index.js" }
              : { "./dsh": "./dsh/src/index.js" },
        };
        delete pkg.scripts;
        if (target.id === "opencode") {
          delete pkg.dsh;
        } else {
          const patchPath = join(payloadRoot, "cordis.patch.yml");
          const patch = await readFile(patchPath, "utf8");
          await writeFile(
            patchPath,
            patch.replaceAll(`${sourcePackage.name}/dsh`, `${pkg.name}/dsh`),
          );
        }
        await writeJson(join(payloadRoot, "package.json"), pkg);
      }
      await validateLinks(stagingRoot, `Staged ${target.title} plugin`);
      if (target.npm) {
        const [packed] = JSON.parse(
          run(
            "npm",
            [
              "pack",
              "--json",
              "--ignore-scripts",
              "--pack-destination",
              temporaryRoot,
            ],
            { cwd: payloadRoot },
          ),
        );
        await rename(join(temporaryRoot, packed.filename), archive);
      } else {
        run("zip", ["-q", "-r", "-X", archive, "."], { cwd: stagingRoot });
        run("unzip", ["-tqq", archive]);
      }
      archives.push(archiveName);
    }
    // Publish only after every host has packaged successfully.
    await mkdir(releaseRoot, { recursive: true });
    for (const archiveName of archives) {
      await rename(
        join(temporaryRoot, archiveName),
        join(releaseRoot, archiveName),
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  for (const archiveName of archives)
    console.log(`Packaged: ${join(releaseRoot, archiveName)}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const repositoryRoot = await findRepositoryRoot(process.cwd());
  const outputRoot = await canonicalPath(
    resolve(options.output ?? join(repositoryRoot, "dist", "plugins")),
  );
  const names = options.all
    ? await pluginNames(repositoryRoot)
    : [options.plugin];
  if (names.length === 0) throw new Error("No plugins found");

  for (const name of names) {
    await packagePlugin(repositoryRoot, name, outputRoot);
  }
}

main().catch((error) => {
  console.error(`package-plugins: ${error.message}`);
  process.exitCode = 1;
});
