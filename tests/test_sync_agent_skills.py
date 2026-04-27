import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "sync-agent-skills.sh"


class SyncAgentSkillsTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="sync-agent-skills-"))
        self.source = self.tmpdir / "skills"
        self.target = self.tmpdir / ".agents" / "skills"
        self.source.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def run_script(self, *args):
        env = os.environ.copy()
        env["LC_ALL"] = "C"
        return subprocess.run(
            [str(SCRIPT), *map(str, args)],
            cwd=REPO_ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def write_skill(self, name, files):
        skill_dir = self.source / name
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(f"---\nname: {name}\n---\n", encoding="utf-8")
        for relative_path, contents in files.items():
            file_path = skill_dir / relative_path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(contents, encoding="utf-8")
        return skill_dir

    def test_syncs_all_skills_and_removes_target_stale_files(self):
        self.write_skill("agent-browser", {"reference/core.md": "fresh"})
        self.write_skill("ego-cli", {"templates/capture.sh": "template"})
        stale_file = self.target / "agent-browser" / "reference" / "old.md"
        stale_file.parent.mkdir(parents=True)
        stale_file.write_text("stale", encoding="utf-8")

        result = self.run_script("--source", self.source, "--target", self.target)

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertEqual(
            (self.target / "agent-browser" / "reference" / "core.md").read_text(encoding="utf-8"),
            "fresh",
        )
        self.assertEqual(
            (self.target / "ego-cli" / "templates" / "capture.sh").read_text(encoding="utf-8"),
            "template",
        )
        self.assertFalse(stale_file.exists())

    def test_sync_preserves_runtime_site_experience(self):
        self.write_skill("agent-browser", {"reference/experience-authoring.md": "fresh"})
        runtime_site = self.target / "agent-browser" / "reference" / "sites" / "example.com" / "site.md"
        runtime_site.parent.mkdir(parents=True)
        runtime_site.write_text("runtime experience", encoding="utf-8")

        result = self.run_script("--source", self.source, "--target", self.target, "agent-browser")

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertEqual(runtime_site.read_text(encoding="utf-8"), "runtime experience")
        self.assertEqual(
            (self.target / "agent-browser" / "reference" / "experience-authoring.md").read_text(
                encoding="utf-8"
            ),
            "fresh",
        )

    def test_syncs_only_named_skills(self):
        self.write_skill("agent-browser", {"reference/core.md": "fresh"})
        self.write_skill("ego-cli", {"reference/core.md": "other"})

        result = self.run_script("--source", self.source, "--target", self.target, "agent-browser")

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertTrue((self.target / "agent-browser" / "SKILL.md").exists())
        self.assertFalse((self.target / "ego-cli").exists())

    def test_ignores_ds_store_files(self):
        self.write_skill("agent-browser", {".DS_Store": "macos", "reference/.DS_Store": "macos"})

        result = self.run_script("--source", self.source, "--target", self.target)

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertFalse((self.target / "agent-browser" / ".DS_Store").exists())
        self.assertFalse((self.target / "agent-browser" / "reference" / ".DS_Store").exists())

    def test_dry_run_does_not_create_target(self):
        self.write_skill("agent-browser", {"reference/core.md": "fresh"})

        result = self.run_script("--source", self.source, "--target", self.target, "--dry-run")

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("Would sync agent-browser", result.stdout)
        self.assertFalse(self.target.exists())

    def test_rejects_missing_named_skill(self):
        self.write_skill("agent-browser", {})

        result = self.run_script("--source", self.source, "--target", self.target, "missing-skill")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing skill source", result.stderr)


class AgentBrowserSkillMetadataTest(unittest.TestCase):
    def test_agent_browser_declares_read_and_write_tools(self):
        skill_path = REPO_ROOT / "skills" / "agent-browser" / "SKILL.md"
        skill_text = skill_path.read_text(encoding="utf-8")
        frontmatter = skill_text.split("---", 2)[1]

        self.assertIn("allowed-tools:", frontmatter)
        self.assertIn("Read", frontmatter)
        self.assertIn("Write", frontmatter)
        self.assertIn("Bash(python3:*)", frontmatter)

    def test_agent_browser_uses_auto_connect_by_default(self):
        skill_path = REPO_ROOT / "skills" / "agent-browser" / "SKILL.md"
        skill_text = skill_path.read_text(encoding="utf-8")
        opening_browsers = skill_text.split("## Opening browsers", 1)[1].split("## Start here", 1)[0]

        self.assertIn("By default, open pages with `--auto-connect`", opening_browsers)
        self.assertIn("agent-browser --auto-connect open", opening_browsers)
        self.assertNotIn("--profile", opening_browsers)
        self.assertNotIn("fallback", opening_browsers.lower())

    def test_experience_authoring_promotes_executable_mechanics(self):
        authoring_path = REPO_ROOT / "skills" / "agent-browser" / "reference" / "experience-authoring.md"
        authoring_text = authoring_path.read_text(encoding="utf-8")

        self.assertIn("Escalate beyond a site note", authoring_text)
        self.assertIn("read-only page-context requests", authoring_text)
        self.assertIn("runnable logic belongs in tools", authoring_text)
        self.assertIn("ordering or validation logic", authoring_text)


if __name__ == "__main__":
    unittest.main()
