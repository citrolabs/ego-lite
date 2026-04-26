import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "skills" / "agent-browser" / "scripts" / "check-site-experience.py"
SKILL = REPO_ROOT / "skills" / "agent-browser" / "SKILL.md"


class SiteExperienceLookupTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="site-experience-"))
        self.skill_root = self.tmpdir / "agent-browser"
        self.sites_dir = self.skill_root / "reference" / "sites"

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def run_lookup(self, *args):
        env = os.environ.copy()
        env["LC_ALL"] = "C"
        return subprocess.run(
            ["python3", str(SCRIPT), *map(str, args)],
            cwd=REPO_ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def write_site(self, site_folder, site_frontmatter, files):
        site_dir = self.sites_dir / site_folder
        site_dir.mkdir(parents=True)
        (site_dir / "site.md").write_text(site_frontmatter, encoding="utf-8")
        for relative_path, contents in files.items():
            path = site_dir / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents, encoding="utf-8")
        return site_dir

    def test_missing_sites_dir_returns_english_none_yaml(self):
        result = self.run_lookup("--url", "https://example.com", "--sites-dir", self.sites_dir)

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("status: none", result.stdout)
        self.assertIn("url: https://example.com", result.stdout)
        self.assertIn("host: example.com", result.stdout)
        self.assertNotIn("没有", result.stdout)

    def test_unknown_host_returns_none_yaml(self):
        self.write_site(
            "gmail.com",
            "---\nname: Gmail\ndescription: Gmail web app experience.\n---\n",
            {},
        )

        result = self.run_lookup("--url", "https://example.com", "--sites-dir", self.sites_dir)

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("status: none", result.stdout)
        self.assertIn("host: example.com", result.stdout)

    def test_found_site_returns_tools_and_workflows_index(self):
        self.write_site(
            "gmail.com",
            "---\nname: Gmail\ndescription: Gmail web app experience.\nhosts:\n  - mail.google.com\n---\n",
            {
                "tools/search/search-mail.py": (
                    "# ---\n"
                    "# name: search-mail\n"
                    "# description: Search Gmail messages by query.\n"
                    "# inputs:\n"
                    "#   - query\n"
                    "# ---\n"
                ),
                "tools/_common.py": "# shared helper should not be indexed\n",
                "workflows/inbox/read-first-5-unread.md": (
                    "---\nname: read-first-5-unread\n"
                    "description: Read and summarize the first five unread emails.\n"
                    "tools:\n"
                    "  - reference/sites/gmail.com/tools/search/search-mail.py\n"
                    "---\n"
                ),
            },
        )

        result = self.run_lookup(
            "--url",
            "https://mail.google.com/mail/u/0/#inbox",
            "--sites-dir",
            self.sites_dir,
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("status: found", result.stdout)
        self.assertIn("host: mail.google.com", result.stdout)
        self.assertIn("name: Gmail", result.stdout)
        self.assertIn("path: reference/sites/gmail.com/site.md", result.stdout)
        self.assertIn("tools:", result.stdout)
        self.assertIn("name: search-mail", result.stdout)
        self.assertIn("path: reference/sites/gmail.com/tools/search/search-mail.py", result.stdout)
        self.assertIn("inputs:", result.stdout)
        self.assertIn("- query", result.stdout)
        self.assertNotIn("_common.py", result.stdout)
        self.assertIn("workflows:", result.stdout)
        self.assertIn("name: read-first-5-unread", result.stdout)
        self.assertIn(
            "path: reference/sites/gmail.com/workflows/inbox/read-first-5-unread.md",
            result.stdout,
        )

    def test_exact_site_folder_host_match_works_without_alias(self):
        self.write_site(
            "example.com",
            "---\nname: Example\ndescription: Example site experience.\n---\n",
            {},
        )

        result = self.run_lookup("--url", "https://example.com/path", "--sites-dir", self.sites_dir)

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("status: found", result.stdout)
        self.assertIn("name: Example", result.stdout)

    def test_lookup_skips_invalid_tools_and_workflows(self):
        self.write_site(
            "example.com",
            "---\nname: Example\ndescription: Example site experience.\n---\n",
            {
                "tools/search/valid-tool.py": (
                    "# ---\n"
                    "# name: valid-tool\n"
                    "# description: Valid reusable tool.\n"
                    "# ---\n"
                    "\n"
                    "def main():\n"
                    "    return 0\n"
                ),
                "tools/search/missing-metadata.py": "print('bad')\n",
                "tools/search/broken.py": (
                    "# ---\n"
                    "# name: broken\n"
                    "# description: Broken tool.\n"
                    "# ---\n"
                    "\n"
                    "def broken(:\n"
                    "    pass\n"
                ),
                "workflows/search/valid-workflow.md": (
                    "---\n"
                    "name: valid-workflow\n"
                    "description: Valid workflow.\n"
                    "tools:\n"
                    "  - reference/sites/example.com/tools/search/valid-tool.py\n"
                    "---\n"
                ),
                "workflows/search/missing-tools.md": (
                    "---\n"
                    "name: missing-tools\n"
                    "description: Missing tools metadata.\n"
                    "---\n"
                ),
                "workflows/search/missing-reference.md": (
                    "---\n"
                    "name: missing-reference\n"
                    "description: Missing referenced tool.\n"
                    "tools:\n"
                    "  - reference/sites/example.com/tools/search/not-found.py\n"
                    "---\n"
                ),
            },
        )

        result = self.run_lookup("--url", "https://example.com/path", "--sites-dir", self.sites_dir)

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("name: valid-tool", result.stdout)
        self.assertIn("name: valid-workflow", result.stdout)
        self.assertNotIn("missing-metadata.py", result.stdout)
        self.assertNotIn("broken.py", result.stdout)
        self.assertNotIn("missing-tools", result.stdout)
        self.assertNotIn("missing-reference", result.stdout)


class SiteExperienceSkillInstructionTest(unittest.TestCase):
    def test_skill_instructs_lookup_before_site_operation(self):
        skill_text = SKILL.read_text(encoding="utf-8")

        self.assertIn("## Site experience lookup", skill_text)
        self.assertIn("check-site-experience.py", skill_text)
        self.assertIn("status: found", skill_text)
        self.assertIn("status: none", skill_text)
        self.assertIn("normal exploration", skill_text)
        self.assertIn("read `site.path`", skill_text)
        self.assertIn("first for site notes", skill_text)
        self.assertIn("Tool paths are executable Python scripts", skill_text)
        self.assertIn("Tool scripts print YAML", skill_text)


if __name__ == "__main__":
    unittest.main()
