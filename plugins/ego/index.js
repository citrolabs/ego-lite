import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const skillsPath = fileURLToPath(new URL("./skills", import.meta.url));
const skillFile = fileURLToPath(
  new URL("./skills/ego-browser/SKILL.md", import.meta.url),
);

// OpenCode 1 calls server() and OpenCode 2 calls setup(); each ignores the
// other, so one default export serves both.
export default {
  id: "citrolabs.ego",
  async server() {
    return {
      config: async (config) => {
        // OpenCode hands plugins its normalized config, which keeps extra Skill
        // folders in skills.paths. Each discovered Skill also becomes a command.
        config.skills ??= {};
        config.skills.paths ??= [];
        if (!config.skills.paths.includes(skillsPath)) {
          config.skills.paths.push(skillsPath);
        }
      },
    };
  },
  async setup(ctx) {
    // OpenCode 2 plugins add Skills one at a time. Shape it the way OpenCode
    // reads a Skill folder, and let a Skill the user already has win.
    const markdown = await readFile(skillFile, "utf8");
    const [, frontMatter, content] = markdown.match(
      /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/,
    );
    const field = (key) =>
      frontMatter.match(new RegExp(`^${key}: (.+)$`, "m"))[1].trim();
    const skill = {
      id: "ego-browser",
      name: field("name"),
      description: field("description"),
      path: skillFile,
      content,
    };
    await ctx.skill.transform((editor) => {
      if (!editor.get(skill.id)) editor.add(skill);
    });
  },
};
