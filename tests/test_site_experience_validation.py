import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_ROOT = REPO_ROOT / "skills" / "agent-browser"
INSTALLED_SKILL_ROOT = REPO_ROOT / ".agents" / "skills" / "agent-browser"
SCRIPT = SKILL_ROOT / "scripts" / "validate-site-experience.py"
SKILL = SKILL_ROOT / "SKILL.md"
AUTHORING_GUIDE = SKILL_ROOT / "reference" / "experience-authoring.md"
INSTALLED_SKILL = INSTALLED_SKILL_ROOT / "SKILL.md"
INSTALLED_AUTHORING_GUIDE = INSTALLED_SKILL_ROOT / "reference" / "experience-authoring.md"


VALID_TOOL = (
    "# ---\n"
    "# name: search-site\n"
    "# description: Search the site by query.\n"
    "# inputs:\n"
    "#   - query\n"
    "# ---\n"
    "\n"
    "def main():\n"
    "    return 0\n"
)


class SiteExperienceValidationTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="site-validation-"))
        self.skill_root = self.tmpdir / "agent-browser"
        self.site_dir = self.skill_root / "reference" / "sites" / "example.com"
        self.site_dir.mkdir(parents=True)
        (self.site_dir / "site.md").write_text(
            "---\n"
            "name: Example\n"
            "description: Example site experience.\n"
            "hosts:\n"
            "  - www.example.com\n"
            "---\n"
            "\n"
            "# Example\n",
            encoding="utf-8",
        )

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def run_validator(self, *args):
        env = os.environ.copy()
        env["LC_ALL"] = "C"
        return subprocess.run(
            [
                "python3",
                str(SCRIPT),
                "--skill-root",
                str(self.skill_root),
                *map(str, args),
            ],
            cwd=REPO_ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def write_valid_tool(self, relative_path="tools/search/search-site.py"):
        path = self.site_dir / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(VALID_TOOL, encoding="utf-8")
        return path

    def write_workflow(self, tool_path="reference/sites/example.com/tools/search/search-site.py"):
        path = self.site_dir / "workflows/search/search-site.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "---\n"
            "name: search-site-workflow\n"
            "description: Search the site and verify results.\n"
            "tools:\n"
            f"  - {tool_path}\n"
            "---\n"
            "\n"
            "# Search site workflow\n",
            encoding="utf-8",
        )
        return path

    def test_valid_site_returns_ok_yaml(self):
        self.write_valid_tool()
        self.write_workflow()

        result = self.run_validator("--site", "example.com")

        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("status: ok", result.stdout)
        self.assertIn("site: example.com", result.stdout)
        self.assertIn("errors: []", result.stdout)

    def test_missing_tool_metadata_returns_error_yaml(self):
        path = self.site_dir / "tools/search/bad-tool.py"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("print('missing metadata')\n", encoding="utf-8")

        result = self.run_validator("--site", "example.com")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("status: error", result.stdout)
        self.assertIn("Missing tool metadata", result.stdout)
        self.assertIn("bad-tool.py", result.stdout)

    def test_missing_workflow_tool_reference_returns_error_yaml(self):
        self.write_valid_tool()
        self.write_workflow("reference/sites/example.com/tools/search/missing.py")

        result = self.run_validator("--site", "example.com")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("status: error", result.stdout)
        self.assertIn("Workflow references missing tool", result.stdout)
        self.assertIn("missing.py", result.stdout)

    def test_category_limit_returns_error_yaml(self):
        for index in range(21):
            self.write_valid_tool(f"tools/search/tool-{index}.py")

        result = self.run_validator("--site", "example.com")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("status: error", result.stdout)
        self.assertIn("exceeds 20 files", result.stdout)
        self.assertIn("tools/search", result.stdout)

    def test_python_compile_error_returns_error_yaml(self):
        path = self.site_dir / "tools/search/broken.py"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "# ---\n"
            "# name: broken\n"
            "# description: Broken tool.\n"
            "# ---\n"
            "\n"
            "def broken(:\n"
            "    pass\n",
            encoding="utf-8",
        )

        result = self.run_validator("--site", "example.com")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("status: error", result.stdout)
        self.assertIn("Python compile failed", result.stdout)
        self.assertIn("broken.py", result.stdout)

    def test_site_notes_body_over_2000_chars_returns_error_yaml(self):
        long_notes = "x" * 2001
        (self.site_dir / "site.md").write_text(
            "---\n"
            "name: Example\n"
            "description: Example site experience.\n"
            "---\n"
            "\n"
            f"{long_notes}\n",
            encoding="utf-8",
        )

        result = self.run_validator("--site", "example.com")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("status: error", result.stdout)
        self.assertIn("site.md body exceeds 2000 characters", result.stdout)
        self.assertIn("site.md", result.stdout)


class SiteExperienceMaintenanceDocumentationTest(unittest.TestCase):
    def test_skill_points_to_runtime_maintenance_guide(self):
        skill_text = SKILL.read_text(encoding="utf-8")

        self.assertIn("## Runtime experience maintenance", skill_text)
        self.assertIn("reference/experience-authoring.md", skill_text)
        self.assertIn("current installed skill root", skill_text)
        self.assertIn("Before the final response", skill_text)
        self.assertIn("maintenance check", skill_text)
        self.assertIn("before deciding", skill_text)
        self.assertIn("maintaining site experience", skill_text)
        self.assertIn("update or generalize the closest fit", skill_text)
        self.assertIn("Tool and workflow budgets are limited", skill_text)
        self.assertIn("Final answer: list maintained paths or the skip reason", skill_text)
        self.assertIn("Maintain mechanics, not content", skill_text)
        self.assertLessEqual(len(skill_text.splitlines()), 110)
        self.assertIn("reusable", skill_text)
        self.assertIn("workflow", skill_text)
        self.assertIn("Ask before writing only", skill_text)
        self.assertIn("validate-site-experience.py", skill_text)

    def test_authoring_guide_records_maintenance_constraints(self):
        guide_text = AUTHORING_GUIDE.read_text(encoding="utf-8")

        self.assertIn("apply these gates", guide_text)
        self.assertIn("write/update without asking", guide_text)
        self.assertIn("report the skip reason", guide_text)
        self.assertIn("Keep tools atomic", guide_text)
        self.assertIn("Private or authenticated sessions are allowed", guide_text)
        self.assertIn("Use existing artifacts first", guide_text)
        self.assertIn("update or generalize the closest fit", guide_text)
        self.assertIn("add a new artifact only when the mechanic has no clear home", guide_text)
        self.assertIn("Tool and workflow budgets are limited", guide_text)
        self.assertIn("Tool: reusable automation", guide_text)
        self.assertIn("Workflow: non-obvious sequence", guide_text)
        self.assertIn("Site note: stable site knowledge", guide_text)
        self.assertIn("2000 characters", guide_text)
        self.assertIn("20 files", guide_text)
        self.assertIn("Do not save `@eN` refs", guide_text)
        self.assertIn("rsync --delete", guide_text)

    def test_installed_agent_browser_docs_match_source_docs(self):
        self.assertEqual(
            SKILL.read_text(encoding="utf-8"),
            INSTALLED_SKILL.read_text(encoding="utf-8"),
        )
        self.assertEqual(
            AUTHORING_GUIDE.read_text(encoding="utf-8"),
            INSTALLED_AUTHORING_GUIDE.read_text(encoding="utf-8"),
        )


class InstalledRuntimeExperienceValidationTest(unittest.TestCase):
    def test_installed_runtime_site_experience_validates(self):
        sites_dir = INSTALLED_SKILL_ROOT / "reference" / "sites"
        if not sites_dir.exists():
            self.skipTest("No installed runtime site experience is present.")

        site_names = sorted(path.name for path in sites_dir.iterdir() if path.is_dir())
        if not site_names:
            self.skipTest("No installed runtime site experience is present.")

        for site_name in site_names:
            with self.subTest(site=site_name):
                result = subprocess.run(
                    [
                        "python3",
                        str(SCRIPT),
                        "--site",
                        site_name,
                        "--skill-root",
                        str(INSTALLED_SKILL_ROOT),
                    ],
                    cwd=REPO_ROOT,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                )

                self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
                self.assertIn("status: ok", result.stdout)
                self.assertIn(f"site: {site_name}", result.stdout)


if __name__ == "__main__":
    unittest.main()
