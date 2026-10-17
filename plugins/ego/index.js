import { fileURLToPath } from "node:url";

const skillPath = fileURLToPath(
  new URL("./skills/ego-browser/SKILL.md", import.meta.url),
);

export const EgoBrowserPlugin = async () => ({
  config: async (config) => {
    config.instructions ??= [];
    if (!config.instructions.includes(skillPath)) {
      config.instructions.push(skillPath);
    }

    config.command ??= {};
    config.command["ego-browser"] ??= {
      description: "Automate the browser with ego-browser",
      template:
        "Follow the installed ego-browser Skill for this request: $ARGUMENTS",
    };
  },
});
