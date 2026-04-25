import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
GMAIL_TOOLS = REPO_ROOT / "skills" / "agent-browser" / "reference" / "sites" / "gmail.com" / "tools"


class GmailToolScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="gmail-tools-"))
        self.fake_agent_browser = self.tmpdir / "agent-browser"

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def write_fake_agent_browser(self, body):
        self.fake_agent_browser.write_text(body, encoding="utf-8")
        self.fake_agent_browser.chmod(self.fake_agent_browser.stat().st_mode | stat.S_IXUSR)

    def run_tool(self, relative_path, *args):
        env = os.environ.copy()
        env["LC_ALL"] = "C"
        env["AGENT_BROWSER_BIN"] = str(self.fake_agent_browser)
        return subprocess.run(
            ["python3", str(GMAIL_TOOLS / relative_path), *map(str, args)],
            cwd=REPO_ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_search_mail_missing_query_returns_yaml_error(self):
        result = self.run_tool("search/search-mail.py")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("status: error", result.stdout)
        self.assertIn("message:", result.stdout)

    def test_open_search_result_without_rows_returns_yaml_none(self):
        self.write_fake_agent_browser(
            "#!/usr/bin/env bash\n"
            "if [[ \"$1\" == \"snapshot\" ]]; then\n"
            "  echo '- heading \"No results\" [level=1, ref=e1]'\n"
            "  exit 0\n"
            "fi\n"
            "echo ok\n"
        )

        result = self.run_tool("reading/open-search-result.py", "--index", "1")

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("status: none", result.stdout)
        self.assertIn("No visible search results", result.stdout)

    def test_read_current_email_outputs_yaml_text(self):
        self.write_fake_agent_browser(
            "#!/usr/bin/env bash\n"
            "if [[ \"$1 $2\" == \"get title\" ]]; then echo 'Subject - Gmail'; exit 0; fi\n"
            "if [[ \"$1 $2\" == \"get url\" ]]; then echo 'https://mail.google.com/mail/u/0/#inbox/abc'; exit 0; fi\n"
            "if [[ \"$1 $2\" == \"get text\" ]]; then echo 'Subject'; echo 'Email body'; exit 0; fi\n"
            "exit 1\n"
        )

        result = self.run_tool("reading/read-current-email.py")

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("status: ok", result.stdout)
        self.assertIn("title: Subject - Gmail", result.stdout)
        self.assertIn("text: |", result.stdout)
        self.assertIn("Email body", result.stdout)

    def test_collect_search_results_summarizes_visible_rows(self):
        payload = (
            '{"range":"1-2 of 2","next_disabled":true,"rows":['
            '{"sender":"GitHub","email":"noreply@github.com","subject":"Security alert",'
            '"visible_date":"Apr 24","date_title":"Apr 24, 2026","thread_count":3},'
            '{"sender":"Apple","email":"no_reply@email.apple.com","subject":"Receipt",'
            '"visible_date":"Apr 23","date_title":"Apr 23, 2026","thread_count":1}'
            ']}'
        )
        self.write_fake_agent_browser(
            "#!/usr/bin/env bash\n"
            "if [[ \"$1\" == \"eval\" ]]; then\n"
            f"  printf '%s\\n' {payload!r}\n"
            "  exit 0\n"
            "fi\n"
            "echo unexpected >&2\n"
            "exit 1\n"
        )

        result = self.run_tool("search/collect-search-results.py", "--max-pages", "1")

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("status: ok", result.stdout)
        self.assertIn("total_conversation_rows: 2", result.stdout)
        self.assertIn("total_weighted_by_thread_count: 4", result.stdout)
        self.assertIn("sender: GitHub", result.stdout)
        self.assertIn("count: 1", result.stdout)
        self.assertIn("weighted_count: 3", result.stdout)

    def test_collect_search_results_without_rows_returns_none(self):
        self.write_fake_agent_browser(
            "#!/usr/bin/env bash\n"
            "if [[ \"$1\" == \"eval\" ]]; then\n"
            "  printf '%s\\n' '{\"range\":\"0\",\"next_disabled\":true,\"rows\":[]}'\n"
            "  exit 0\n"
            "fi\n"
            "echo unexpected >&2\n"
            "exit 1\n"
        )

        result = self.run_tool("search/collect-search-results.py", "--max-pages", "1")

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("status: none", result.stdout)
        self.assertIn("No Gmail search result rows", result.stdout)


if __name__ == "__main__":
    unittest.main()
