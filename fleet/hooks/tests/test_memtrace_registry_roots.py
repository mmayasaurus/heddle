#!/usr/bin/env python3
"""Regression tests for HED-84 opt-in Memtrace hook roots."""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock


HOOK = Path(__file__).resolve().parent.parent / "require-memtrace-first.py"


def load_hook():
    spec = importlib.util.spec_from_file_location("require_memtrace_first", HOOK)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# HED-84 permanent attack table — the point of the allowlist redesign.
#
# Every shell escape found across the adversarial rounds lives here beside the
# legitimate queries the gate must keep exempting. Rows are exactly
# (command, should_be_exempt, expected_exit):
#
#   should_be_exempt  what command_is_valid_memtrace_query must answer.
#   expected_exit     literal enforce_query_order result with empty state.
#
# The test also drives enforce_query_order for an enforce=true opted-in root
# with EMPTY session state: exempt commands exit 0; non-exempt commands that
# contain a source search exit 2. Other non-exempt commands exit 0 because the
# failed exemption buys them nothing, but there is no source search to block.
#
# `enabled` is the opted-in fixture root's basename, i.e. its repo_id.
#
# MUTATION GUARD — this table is worth having only if it fails when the gate
# breaks: every DENY row must fail if command_is_valid_memtrace_query is made to
# always return True, and every ALLOW row must fail if the exemption is removed.
# A row that cannot fail in its mutation direction is not testing the gate.
# ---------------------------------------------------------------------------
GATE_EXEMPTION_CASES = [
    # -- chained / substituted shell, denied because a search follows ---------
    # Each DENY row must fail if the gate allowlist is forced always-true.
    ("memtrace find-code x enabled && grep -r secret /", False, 2),
    ("memtrace find-code x enabled | grep -r secret /", False, 2),
    ("memtrace find-code x enabled ; grep -r foo .", False, 2),
    ('memtrace find-code "$(grep -rl x /)" enabled', False, 2),
    ("memtrace find-code x enabled `grep -r x /`", False, 2),
    ("memtrace find-code x enabled > out; grep -r /", False, 2),
    ("memtrace find-code x enabled <(grep -r /)", False, 2),
    ("env X=1 memtrace find-code x enabled && grep -r /", False, 2),
    ("command memtrace find-code x enabled && grep -r secret /", False, 2),
    ('memtrace find-code "x" enabled; cat src/a.py', False, 2),
    # A newline or carriage return separates commands in bash, which is why the
    # grammar joins arguments with spaces and tabs only, never `\s`.
    ("memtrace find-code x enabled\ngrep -r secret /", False, 2),
    ("memtrace find-code x enabled\rgrep -r secret /", False, 2),
    # -- quoting forms the old hand-rolled scanner mis-modelled ---------------
    # ANSI-C quoting (round 6b).
    ("memtrace find-code $'x\\n grep -r /' enabled", False, 2),
    # Locale quoting (round 6b).
    ('memtrace find-code $"x grep -r /" enabled', False, 2),
    # The round-6 desync: bash keeps `\'` inside $'...' as a literal quote that
    # does NOT close the string, so a toggle-on-every-quote scanner loses sync
    # and reads the trailing `; grep ...` as quoted text.
    ("memtrace find-code enabled $'a\\'b'; grep -r x / #'", False, 2),
    ("memtrace find-code heddle $'a\\'b'; grep -r x / #'", False, 2),
    # An unbalanced quote must never satisfy the recognizer.
    ('memtrace find-code "x enabled', False, 0),
    ("memtrace find-code 'x enabled", False, 0),
    # -- no exemption without a real, single memtrace call --------------------
    ("grep -r foo .", False, 2),
    # An UNQUOTED search binary as the query term stays denied by design; quote
    # it and it is data again (see the allow rows).
    ("memtrace find-code grep enabled", False, 2),
    # Two invocations on one command line: one exemption covers one call.
    ("memtrace find-code x enabled memtrace find-code y enabled", False, 0),
    # Expansions are refused even where they cannot reach a second command —
    # the recognizer cannot account for what they expand to.
    ("memtrace find-code $VAR enabled", False, 0),
    ("memtrace find-code x enabled${IFS}grep${IFS}-r${IFS}/", False, 0),
    ("memtrace find-code ~/x enabled", False, 0),
    ("memtrace find-code *.py enabled", False, 0),
    # Redirections are not in the grammar (already true before HED-84).
    ("memtrace find-code x enabled >>results.txt", False, 0),
    ("memtrace find-code x enabled 2>&1", False, 0),
    # bash resolves command names case-sensitively; MEMTRACE is another binary.
    ("MEMTRACE find-code x enabled", False, 0),
    # repo_id matching is whole-token: enabled-old is not enabled.
    ("memtrace find-code x enabled-old", False, 0),
    # curl is not GATE-exempt (it does not start with `memtrace`), so it stays
    # False here. The localhost insight-card substring IS credited in the RECORD
    # path (command_mentions_memtrace_query — see the record test); recording is
    # separate from gate exemption, so nothing about the gate regresses.
    ("curl -s localhost:3030/api/repos", False, 0),
    ("echo localhost:3030/api/repos && grep -r secret /", False, 2),
    # -- the legitimate queries the gate must keep exempting ------------------
    ('memtrace find-code "how does grep work" enabled', True, 0),
    ('memtrace find-code "where is rg used" enabled', True, 0),
    ("memtrace search 'find the bug' enabled", True, 0),
    ("memtrace find-code enabled", True, 0),
    ("memtrace insight-card enabled", True, 0),
    ("heddle memtrace impact enabled", True, 0),
    ("memtrace find-code path/to/file.py enabled", True, 0),
    ("memtrace find-symbol enabled MyClass", True, 0),
    ("memtrace find_code enabled x", True, 0),
    # A quoted repo_id counts: tokens are compared after dequoting.
    ('memtrace find-code "quoted repo" "enabled"', True, 0),
    # Escaped quotes inside a double-quoted argument stay data.
    ('memtrace find-code "he said \\"hi\\"" enabled', True, 0),
    # Tabs and runs of spaces are ordinary bash separators.
    ("memtrace\tfind-code\tx\tenabled", True, 0),
    ("  memtrace   find-code   x   enabled  ", True, 0),
    # A real newline in quotes is one bash word, so it remains gate-exempt.
    ('memtrace find-code "a' + chr(10) + 'grep -r /" enabled', True, 0),
]

# RECORD mode is deliberately LOOSER than the gate exemption: it answers "did
# this session consult the memory layer at all", so a query inside a pipeline
# still counts. Rows are (command, should_record).
RECORD_CASES = [
    # The hook's own denial message tells agents to run exactly this, so it MUST
    # record even though the pipe correctly keeps it out of the gate exemption.
    ("memtrace insight-card enabled | head -40", True),
    ('memtrace search "x" enabled', True),
    ("heddle memtrace impact enabled", True),
    # Recording a query that also greps is harmless: the grep is still judged by
    # the gate on its own merits.
    ("memtrace insight-card enabled && grep -r secret /", True),
    # Loose by design — record mode does not try to prove the call really ran.
    ("echo memtrace find-code x enabled", True),
    ("grep -r foo .", False),
    ("memtrace find-code x unknown-repo-zz", False),
]


class MemtraceRegistryRootsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.tempdir = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write_json(self, name: str, value: object) -> Path:
        path = self.tempdir / name
        path.write_text(json.dumps(value))
        return path

    def load_with(self, enforce: Path | None = None):
        return mock.patch.dict(os.environ, {
            "HEDDLE_MEMTRACE_ENFORCE_JSON": str(enforce or self.tempdir / "missing-enforce.json"),
        }, clear=False)

    def enabled_root(self) -> tuple[Path, Path]:
        """An opted-in root with the gate ENABLED, plus its enforce file."""
        root = self.tempdir / "enabled"
        root.mkdir(exist_ok=True)
        return root, self.write_json("enforce.json", {str(root): True})

    def enforce_exit_code(self, hook, cwd: str, command: object) -> int:
        """Exit code enforce_query_order reaches for a Bash command, empty state."""
        payload = {"cwd": cwd, "tool_name": "Bash", "tool_input": {"command": command}}
        with mock.patch.object(hook, "state_for", return_value=("test-session", {})), \
             mock.patch.object(hook, "allow_pretool", side_effect=SystemExit(0)), \
             mock.patch.object(hook, "save_for"), \
             mock.patch.object(hook, "emit_discipline"), \
             mock.patch.object(hook, "deny_pretool", side_effect=SystemExit(2)):
            with self.assertRaises(SystemExit) as raised:
                hook.enforce_query_order(payload)
        return raised.exception.code

    def deny_recursive_exit_code(self, hook, cwd: str, command: object) -> int:
        """Exit code deny_recursive_search reaches for a Bash command."""
        payload = {"cwd": cwd, "tool_name": "Bash", "tool_input": {"command": command}}
        with mock.patch.object(hook, "state_for", return_value=("test-session", {})), \
             mock.patch.object(hook, "save_for"), \
             mock.patch.object(hook, "emit_discipline"), \
             mock.patch.object(hook, "deny_pretool", side_effect=SystemExit(2)):
            with self.assertRaises(SystemExit) as raised:
                hook.deny_recursive_search(payload)
        return raised.exception.code

    def recorded_state(self, hook, command: object) -> dict:
        """Session state record_memtrace saves for a Bash command ({} if none)."""
        saved: dict = {}
        with mock.patch.object(hook, "state_for", return_value=("test-session", {})), \
             mock.patch.object(hook, "save_for", side_effect=lambda _sid, state: saved.update(state)), \
             mock.patch.object(hook, "emit_discipline"):
            with self.assertRaises(SystemExit):
                hook.record_memtrace({"tool_name": "Bash", "tool_input": {"command": command}})
        return saved

    def test_projects_registry_without_opt_in_leaves_workspace_unindexed(self):
        workspace = self.tempdir / "workspace"
        app = workspace / "Rebuild-Project-Root"
        app.mkdir(parents=True)
        self.write_json("projects.json", {
            "schemaVersion": 1,
            "projects": [{"workspaceRoots": [str(workspace)]}],
        })

        with self.load_with():
            hook = load_hook()
            with mock.patch.object(hook, "PROJECT_ROOT", workspace), mock.patch.object(hook, "APP_MONOREPO", app):
                self.assertIsNone(hook.indexed_repo_root_for_path(str(workspace)))
                self.assertEqual(hook.repo_id_for_path(str(workspace)), hook.CANONICAL_REPO_ID)

    def test_opted_in_root_matches_boundaries_and_uses_basename_repo_id(self):
        root = self.tempdir / "x" / "newthing"
        root.mkdir(parents=True)
        enforce = self.write_json("enforce.json", {str(root): False})

        with self.load_with(enforce):
            hook = load_hook()
            self.assertEqual(hook.indexed_repo_root_for_path(str(root / "src" / "a.ts")), root.resolve())
            self.assertIsNone(hook.indexed_repo_root_for_path(str(root.parent / "newthingy" / "a.ts")))
            self.assertEqual(hook.repo_id_for_path(str(root / "src")), "newthing")

    def test_nested_opted_in_roots_choose_the_longest_match(self):
        outer = self.tempdir / "outer"
        inner = outer / "inner"
        inner.mkdir(parents=True)
        enforce = self.write_json("enforce.json", {str(outer): False, str(inner): True})

        with self.load_with(enforce):
            hook = load_hook()
            self.assertEqual(hook.indexed_repo_root_for_path(str(inner / "src")), inner.resolve())
            self.assertTrue(hook.enforcement_enabled_for(str(inner / "src")))

    def test_hardcoded_roots_keep_priority_over_opted_in_roots(self):
        hardcoded = self.tempdir / "spinventory" / "Rebuild-Project-Root"
        hardcoded.mkdir(parents=True)
        enforce = self.write_json("enforce.json", {str(hardcoded.parent): True})

        with self.load_with(enforce):
            hook = load_hook()
            with mock.patch.object(hook, "APP_MONOREPO", hardcoded):
                self.assertEqual(hook.indexed_repo_root_for_path(str(hardcoded / "src")), hardcoded.resolve())
                self.assertEqual(hook.repo_id_for_path(str(hardcoded / "src")), hook.CANONICAL_REPO_ID)

    def test_missing_corrupt_non_regular_and_oversized_enforce_files_fail_soft(self):
        root = self.tempdir / "newthing"
        root.mkdir()
        cases = [self.tempdir / "missing.json"]
        corrupt = self.tempdir / "corrupt.json"
        corrupt.write_text("not json")
        cases.append(corrupt)
        oversized = self.tempdir / "oversized.json"
        oversized.write_bytes(b" " * (1024 * 1024 + 1))
        cases.append(oversized)
        fifo = self.tempdir / "enforce.fifo"
        os.mkfifo(fifo)
        # tempdir is torn down in tearDown regardless; explicit cleanup keeps the FIFO from outliving
        # an interrupted subTest inside it (amazon-q, PR #39).
        self.addCleanup(fifo.unlink, missing_ok=True)
        cases.append(fifo)

        for enforce in cases:
            with self.subTest(enforce=enforce.name), self.load_with(enforce):
                hook = load_hook()
                self.assertEqual(hook.registry_enforcement_roots(), {})
                self.assertIsNone(hook.indexed_repo_root_for_path(str(root / "src")))

    def test_nonexistent_opted_in_root_matches_lexically(self):
        root = self.tempdir / "not-created" / "newthing"
        enforce = self.write_json("enforce.json", {str(root): True})

        with self.load_with(enforce):
            hook = load_hook()
            self.assertEqual(hook.indexed_repo_root_for_path(str(root / "src")), root.resolve())
            self.assertTrue(hook.enforcement_enabled_for(str(root / "src")))

    def test_root_and_home_are_refused(self):
        project = self.tempdir / "project"
        project.mkdir()
        enforce = self.write_json("enforce.json", {"/": True, str(Path.home()): True, str(project): False})

        with self.load_with(enforce):
            hook = load_hook()
            self.assertEqual(hook.registry_enforcement_roots(), {str(project.resolve()): False})

    def test_opted_in_basename_is_accepted_by_memtrace_queries(self):
        root = self.tempdir / "newthing"
        root.mkdir()
        enforce = self.write_json("enforce.json", {str(root): False})

        with self.load_with(enforce):
            hook = load_hook()
            self.assertTrue(hook.tool_is_valid_memtrace_query("mcp__memtrace__find_code", {"repo_id": "newthing"}))
            self.assertFalse(hook.tool_is_valid_memtrace_query("mcp__memtrace__find_code", {"repo_id": "unknown"}))
            self.assertTrue(hook.command_is_valid_memtrace_query("memtrace find-code newthing lookup"))
            # The paired negative: a real shell `find` is still a denied recursive search.
            self.assertTrue(hook.SEARCH_RE.search("find . -name '*.ts'"))
            self.assertFalse(hook.command_is_valid_memtrace_query("find . -name '*.ts'"))

    def test_memtrace_cli_query_text_does_not_trigger_search_detection(self):
        with self.load_with():
            hook = load_hook()
            self.assertTrue(hook.command_is_valid_memtrace_query(
                'memtrace find-code "where is grep used" Rebuild-Project-Root'
            ))
            self.assertFalse(hook.command_is_valid_memtrace_query("grep -r foo ."))
            self.assertFalse(hook.command_is_valid_memtrace_query("find . -name x"))

    def test_gate_exemption_attack_table(self):
        """Every known escape, checked twice: recognizer verdict AND entry point."""
        root, enforce = self.enabled_root()
        with self.load_with(enforce):
            hook = load_hook()
            for command, should_be_exempt, expected_exit in GATE_EXEMPTION_CASES:
                with self.subTest(command=command):
                    self.assertEqual(
                        hook.command_is_valid_memtrace_query(command),
                        should_be_exempt,
                    )
                    self.assertEqual(
                        self.enforce_exit_code(hook, str(root), command),
                        expected_exit,
                    )

    def test_gate_exempt_commands_are_never_denied_as_recursive_search(self):
        root, enforce = self.enabled_root()
        with self.load_with(enforce):
            hook = load_hook()
            for command, should_be_exempt, _expected_exit in GATE_EXEMPTION_CASES:
                if not should_be_exempt:
                    continue
                with self.subTest(command=command):
                    self.assertEqual(self.deny_recursive_exit_code(hook, str(root), command), 0)

    def test_hardcoded_repo_ids_are_accepted_by_the_gate_grammar(self):
        with self.load_with():
            hook = load_hook()
            cases = {
                'memtrace find-code "where is grep used" Rebuild-Project-Root': True,
                'heddle memtrace find-code "where is find used" Rebuild-Project-Root': True,
                "memtrace find-code x heddle-dashboard": True,
                "memtrace find-code x Rebuild-Project-Root && grep -r secret /": False,
                "memtrace find-code x Rebuild-Project-Root memtrace find-code y Rebuild-Project-Root": False,
                "memtrace find-code grep Rebuild-Project-Root": False,
                # No accepted repo_id token at all.
                "memtrace find-code x some-other-repo": False,
            }
            for command, expected in cases.items():
                with self.subTest(command=command):
                    self.assertEqual(hook.command_is_valid_memtrace_query(command), expected)

    def test_record_mode_is_looser_than_the_gate_exemption(self):
        root, enforce = self.enabled_root()
        with self.load_with(enforce):
            hook = load_hook()
            for command, should_record in RECORD_CASES:
                with self.subTest(command=command):
                    self.assertEqual(hook.command_mentions_memtrace_query(command), should_record)
                    self.assertEqual(
                        bool(self.recorded_state(hook, command).get("queried_memtrace")),
                        should_record,
                    )
            # The split itself: the piped query the hook's own denial message
            # recommends RECORDS, yet is still not gate-exempt.
            piped = "memtrace insight-card enabled | head -40"
            self.assertTrue(self.recorded_state(hook, piped).get("queried_memtrace"))
            self.assertFalse(hook.command_is_valid_memtrace_query(piped))
            self.assertEqual(self.enforce_exit_code(hook, str(root), piped), 0)

    def test_record_detects_memtrace_in_compound_commands_without_widening_the_gate(self):
        root = self.tempdir / "nt"
        root.mkdir()
        enforce = self.write_json("enforce.json", {str(root): True})
        with self.load_with(enforce):
            hook = load_hook()
            recordable = [
                "memtrace insight-card nt; ls",
                "memtrace insight-card nt | head -40",
                "curl -s localhost:3030/api/repos",
                "curl -s http://127.0.0.1:3030/api/repos | jq .",
            ]
            for command in recordable:
                with self.subTest(recordable=command):
                    self.assertTrue(hook.command_mentions_memtrace_query(command))

            for command in ["grep -r foo /etc", "ls -la"]:
                with self.subTest(not_recordable=command):
                    self.assertFalse(hook.command_mentions_memtrace_query(command))

            self.assertTrue(hook.command_is_valid_memtrace_query("memtrace insight-card nt"))
            for command in [
                "memtrace insight-card nt; ls",
                "memtrace insight-card nt | head -40",
                "grep -r foo /",
            ]:
                with self.subTest(gate_must_remain_closed=command):
                    self.assertFalse(hook.command_is_valid_memtrace_query(command))

            # Exercise the real record entry point, not just the recognizer.
            self.assertTrue(
                self.recorded_state(hook, "memtrace insight-card nt; ls").get("queried_memtrace")
            )

    def test_null_bytes_never_crash_path_classification_or_enforcement(self):
        root = self.tempdir / "nt"
        root.mkdir()
        enforce = self.write_json("enforce.json", {str(root): True})
        badpath = "/x" + chr(0) + ".py"
        with self.load_with(enforce):
            hook = load_hook()
            self.assertIsInstance(
                hook.is_source_read_tool("Read", {"file_path": badpath}, "/tmp"), bool
            )
            self.assertIsInstance(
                hook.is_source_discovery("Grep", {"path": badpath, "pattern": "x"}, "/tmp"), bool
            )
            self.assertIsInstance(hook.normalized_path(badpath, "/tmp"), Path)

            for tool_name, tool_input in [
                ("Read", {"file_path": badpath}),
                ("Grep", {"path": badpath, "pattern": "x"}),
                ("Bash", {"command": "grep -r x " + badpath}),
            ]:
                payload = {"tool_name": tool_name, "tool_input": tool_input, "cwd": str(root)}
                with self.subTest(tool_name=tool_name):
                    # A raise here would crash the hook into fail-open.
                    try:
                        hook.enforce_query_order(payload)
                    except SystemExit:
                        pass

    def test_non_string_command_fails_closed_without_crashing(self):
        root, enforce = self.enabled_root()
        cwd = str(root)
        with self.load_with(enforce):
            hook = load_hook()
            for junk in [None, 123, {"command": "x"}, ["grep", "-r", "."]]:
                with self.subTest(kind=type(junk).__name__):
                    self.assertFalse(hook.command_is_valid_memtrace_query(junk))
                    self.assertFalse(hook.command_mentions_memtrace_query(junk))
                    self.assertFalse(hook.is_source_discovery("Bash", {"command": junk}, cwd))
                    self.assertFalse(hook.is_recursive_code_search("Bash", {"command": junk}, cwd))
                    # Both PreToolUse entry points must DECIDE, never raise: an
                    # uncaught TypeError here is a fail-open on the whole gate.
                    self.assertEqual(self.enforce_exit_code(hook, cwd, junk), 0)
                    self.assertEqual(self.deny_recursive_exit_code(hook, cwd, junk), 0)
            # A malformed tool_name must not blow up the set lookups either.
            self.assertFalse(hook.is_source_discovery(["Grep"], {"path": cwd}, cwd))
            self.assertFalse(hook.is_recursive_code_search(["Bash"], {"command": "grep -r x ."}, cwd))

    def test_filesystem_root_keys_never_become_a_repo_id(self):
        enforce = self.write_json("enforce.json", {"/": True, "//": True, "///": True})
        with self.load_with(enforce):
            hook = load_hook()
            self.assertEqual(hook.registry_enforcement_roots(), {})
            self.assertNotIn("", hook.known_repo_ids())

    def test_empty_and_one_character_repo_ids_are_never_accepted(self):
        with self.load_with():
            hook = load_hook()
            # Bypasses the registry's own refusal to prove the second line of
            # defence in known_repo_ids() holds on its own.
            with mock.patch.object(
                hook,
                "registry_enforcement_roots",
                return_value={"//": True, "/x": True, "/ok-repo": True},
            ):
                ids = hook.known_repo_ids()
                self.assertNotIn("", ids)
                self.assertNotIn("x", ids)
                self.assertIn("ok-repo", ids)
                self.assertFalse(hook.command_is_valid_memtrace_query("memtrace find-code query x"))
                self.assertTrue(hook.command_is_valid_memtrace_query("memtrace find-code query ok-repo"))

    def test_valid_memtrace_cli_query_is_allowed_before_source_discovery(self):
        root = self.tempdir / "enabled"
        root.mkdir()
        enforce = self.write_json("enforce.json", {str(root): True})
        payload = {
            "cwd": str(root),
            "tool_name": "Bash",
            "tool_input": {"command": 'memtrace find-code "where is grep used" enabled'},
        }

        with self.load_with(enforce):
            hook = load_hook()
            with mock.patch.object(hook, "state_for", return_value=("test-session", {})), \
                 mock.patch.object(hook, "allow_pretool", side_effect=SystemExit(0)), \
                 mock.patch.object(hook, "save_for"), \
                 mock.patch.object(hook, "emit_discipline"), \
                 mock.patch.object(hook, "deny_pretool", side_effect=SystemExit(2)):
                with self.assertRaises(SystemExit) as raised:
                    hook.enforce_query_order(payload)
            self.assertEqual(raised.exception.code, 0)

    def test_memtrace_cli_query_with_rg_text_is_not_recursively_denied(self):
        root = self.tempdir / "enabled"
        root.mkdir()
        enforce = self.write_json("enforce.json", {str(root): True})
        payload = {
            "cwd": str(root),
            "tool_name": "Bash",
            "tool_input": {"command": 'memtrace find-code "where is rg used" enabled'},
        }

        with self.load_with(enforce):
            hook = load_hook()
            with mock.patch.object(hook, "state_for", return_value=("test-session", {})), \
                 mock.patch.object(hook, "allow_pretool", side_effect=SystemExit(0)), \
                 mock.patch.object(hook, "save_for"), \
                 mock.patch.object(hook, "emit_discipline"), \
                 mock.patch.object(hook, "deny_pretool", side_effect=SystemExit(2)):
                with self.assertRaises(SystemExit) as raised:
                    hook.deny_recursive_search(payload)
            self.assertEqual(raised.exception.code, 0)

    def test_trailing_recursive_grep_after_memtrace_query_is_still_denied(self):
        root = self.tempdir / "enabled"
        root.mkdir()
        enforce = self.write_json("enforce.json", {str(root): True})
        command = "memtrace find-code x enabled; grep -r foo ."
        payload = {"cwd": str(root), "tool_name": "Bash", "tool_input": {"command": command}}

        with self.load_with(enforce):
            hook = load_hook()
            self.assertFalse(hook.command_is_valid_memtrace_query(command))
            with mock.patch.object(hook, "state_for", return_value=("test-session", {})), \
                 mock.patch.object(hook, "save_for"), \
                 mock.patch.object(hook, "emit_discipline"), \
                 mock.patch.object(hook, "deny_pretool", side_effect=SystemExit(2)):
                with self.assertRaises(SystemExit) as raised:
                    hook.enforce_query_order(payload)
            self.assertEqual(raised.exception.code, 2)

    # The source-discovery entry point for these forms — chains, substitutions,
    # ANSI-C/locale quoting, redirections, separators, env/command wrappers, the
    # `$VAR` argument and the retired localhost form — now lives in
    # GATE_EXEMPTION_CASES, which asserts the same exit codes for all of them
    # plus the recognizer verdict behind each.

    def test_memtrace_query_chains_and_substitutions_are_denied_at_recursive_search_entrypoint(self):
        root = self.tempdir / "enabled"
        root.mkdir()
        enforce = self.write_json("enforce.json", {str(root): True})
        commands = [
            "memtrace find-code x enabled && grep -r secret /",
            "memtrace find-code x enabled | grep -r secret /",
            "memtrace find-code x enabled ; grep -r foo .",
            "memtrace find-code x enabled `grep -r x /`",
            'memtrace find-code "$(grep -rl x /)" enabled',
            "echo localhost:3030/api/repos && grep -r secret /",
            "grep -r foo .",
        ]

        with self.load_with(enforce):
            hook = load_hook()
            for command in commands:
                payload = {"cwd": str(root), "tool_name": "Bash", "tool_input": {"command": command}}
                with self.subTest(command=command), \
                     mock.patch.object(hook, "state_for", return_value=("test-session", {})), \
                     mock.patch.object(hook, "save_for"), \
                     mock.patch.object(hook, "emit_discipline"), \
                     mock.patch.object(hook, "deny_pretool", side_effect=SystemExit(2)):
                    with self.assertRaises(SystemExit) as raised:
                        hook.deny_recursive_search(payload)
                    self.assertEqual(raised.exception.code, 2)

    def test_plain_recursive_grep_is_still_denied(self):
        root = self.tempdir / "enabled"
        root.mkdir()
        enforce = self.write_json("enforce.json", {str(root): True})
        payload = {"cwd": str(root), "tool_name": "Bash", "tool_input": {"command": "grep -r foo ."}}

        with self.load_with(enforce):
            hook = load_hook()
            with mock.patch.object(hook, "state_for", return_value=("test-session", {})), \
                 mock.patch.object(hook, "save_for"), \
                 mock.patch.object(hook, "emit_discipline"), \
                 mock.patch.object(hook, "deny_pretool", side_effect=SystemExit(2)):
                with self.assertRaises(SystemExit) as raised:
                    hook.enforce_query_order(payload)
            self.assertEqual(raised.exception.code, 2)

    def test_memtrace_cli_repo_id_requires_a_whole_token(self):
        root = self.tempdir / "app"
        root.mkdir()
        enforce = self.write_json("enforce.json", {str(root): False})

        with self.load_with(enforce):
            hook = load_hook()
            self.assertFalse(hook.command_is_valid_memtrace_query("memtrace find-code app-old lookup"))
            self.assertTrue(hook.command_is_valid_memtrace_query("memtrace find-code lookup app"))
            self.assertTrue(hook.command_is_valid_memtrace_query('memtrace find-code lookup "app"'))
            # HED-84 narrowing: the repo_id must BE an argument, not sit inside
            # one. Buried in a path it no longer earns the exemption. That is
            # strictly fail-closed, and costs nothing at the gate: such a
            # command is not source discovery, so it is allowed on its own
            # merits anyway.
            self.assertFalse(hook.command_is_valid_memtrace_query(
                "memtrace find-code /Users/example/app/src lookup"
            ))

    def test_bad_enforce_entries_do_not_disable_valid_entries(self):
        good_root = self.tempdir / "good"
        good_root.mkdir()
        enforce = self.write_json("enforce.json", {str(good_root): True, "x": 1, "relative/path": True})

        with self.load_with(enforce):
            hook = load_hook()
            self.assertEqual(hook.registry_enforcement_roots(), {str(good_root.resolve()): True})
            self.assertEqual(hook.indexed_repo_root_for_path(str(good_root / "src")), good_root.resolve())
            self.assertTrue(hook.enforcement_enabled_for(str(good_root / "src")))

    def test_registry_limits_additional_roots_to_256_entries(self):
        entries = {
            str(self.tempdir / f"root-{index}"): False
            for index in range(257)
        }
        enforce = self.write_json("enforce.json", entries)

        with self.load_with(enforce):
            hook = load_hook()
            roots = hook.registry_enforcement_roots()
            self.assertEqual(len(roots), 256)
            self.assertNotIn(str(self.tempdir / "root-256"), roots)

    def test_registry_limit_skips_invalid_entries_before_counting_valid_roots(self):
        root = self.tempdir / "real-root"
        root.mkdir()
        entries = {f"invalid-{index}": 1 for index in range(256)}
        entries[str(root)] = True
        enforce = self.write_json("enforce.json", entries)

        with self.load_with(enforce):
            hook = load_hook()
            self.assertEqual(hook.registry_enforcement_roots(), {str(root.resolve()): True})

    @unittest.skipUnless(Path("/private/tmp").exists(), "macOS /private/tmp alias is unavailable")
    def test_tmp_enforce_key_matches_private_tmp_cwd_after_canonicalization(self):
        root = Path(tempfile.mkdtemp(prefix="hed84-", dir="/tmp"))
        self.addCleanup(root.rmdir)
        tmp_spelling = Path("/tmp") / root.name
        private_spelling = Path("/private/tmp") / root.name
        enforce = self.write_json("enforce.json", {str(tmp_spelling): True})

        with self.load_with(enforce):
            hook = load_hook()
            self.assertEqual(hook.indexed_repo_root_for_path(str(private_spelling / "src")), root.resolve())
            self.assertTrue(hook.enforcement_enabled_for(str(private_spelling / "src")))



    def test_false_valued_opt_in_is_indexed_but_record_only(self):
        root = self.tempdir / "recordonly"
        root.mkdir()
        enforce = self.write_json("enforce.json", {str(root): False})
        with self.load_with(enforce):
            hook = load_hook()
            cwd = str(root / "src")
            self.assertEqual(hook.indexed_repo_root_for_path(cwd), root.resolve())
            self.assertEqual(hook.repo_id_for_path(cwd), "recordonly")
            self.assertFalse(hook.enforcement_enabled_for(cwd))

    def test_ancestor_of_hardcoded_root_is_refused(self):
        enforce = self.write_json("enforce.json", {str(self.tempdir): True})
        with self.load_with(enforce):
            hook = load_hook()
            hook.APP_MONOREPO = self.tempdir / "app"
            (self.tempdir / "app").mkdir(exist_ok=True)
            hook.registry_enforcement_roots.cache_clear()
            self.assertEqual(hook.registry_enforcement_roots(), {})

    def test_root_under_hardcoded_root_is_refused_and_not_an_accepted_repo_id(self):
        hardcoded = self.tempdir / "app"
        opted_in_child = hardcoded / "sub"
        opted_in_child.mkdir(parents=True)
        enforce = self.write_json("enforce.json", {str(opted_in_child): True})

        with self.load_with(enforce):
            hook = load_hook()
            with mock.patch.object(hook, "APP_MONOREPO", hardcoded):
                self.assertEqual(hook.registry_enforcement_roots(), {})
                self.assertNotIn("sub", hook.known_repo_ids())

    def test_tilde_path_matches_like_its_absolute_spelling(self):
        # The harness cannot write to the real home directory. Patch the home
        # lookup to the test sandbox while preserving the production spelling.
        with mock.patch.object(Path, "home", return_value=self.tempdir):
            root = Path(tempfile.mkdtemp(prefix="hed84-tilde-", dir=Path.home()))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        enforce = self.write_json("enforce.json", {str(root): False})
        with self.load_with(enforce):
            hook = load_hook()
            with mock.patch.dict(os.environ, {"HOME": str(self.tempdir)}, clear=False):
                home = str(self.tempdir)
                absolute_path = str(root / "a.ts")
                self.assertEqual(
                    hook.indexed_repo_root_for_path("~" + absolute_path[len(home):]),
                    root.resolve(),
                )

    def test_unknown_tilde_user_path_fails_soft(self):
        with self.load_with():
            hook = load_hook()
            path = hook.normalized_path("~nouser_zz/x.ts", str(self.tempdir))
            self.assertIsInstance(path, Path)
            self.assertFalse(hook.is_source_read_tool(
                "Read", {"file_path": "~nouser_zz/x.ts"}, str(self.tempdir)
            ))
            self.assertFalse(hook.is_source_discovery(
                "Read", {"file_path": "~nouser_zz/x.ts"}, str(self.tempdir)
            ))

    def test_canonical_path_unknown_tilde_user_fails_soft(self):
        with self.load_with():
            hook = load_hook()
            self.assertIsInstance(hook.canonical_path("~nouser_zz/x"), Path)

    def test_opted_in_root_classifies_grep_and_bash_cat_as_source_discovery(self):
        root = self.tempdir / "opted-in"
        source = root / "src" / "a.py"
        source.parent.mkdir(parents=True)
        source.write_text("print('hello')\n")
        enforce = self.write_json("enforce.json", {str(root): True})

        with self.load_with(enforce):
            hook = load_hook()
            cwd = str(root / "src")
            self.assertTrue(hook.is_source_discovery("Grep", {"path": cwd}, cwd))
            self.assertTrue(hook.is_source_discovery("Bash", {"command": f"cat {source}"}, cwd))

    def test_missing_enforce_file_keeps_outside_workspace_discovery_unchanged(self):
        outside = self.tempdir / "outside"
        outside.mkdir()
        with self.load_with():
            hook = load_hook()
            self.assertFalse(hook.is_source_discovery("Grep", {"path": str(outside)}, str(outside)))
            self.assertFalse(hook.is_source_discovery(
                "Bash", {"command": f"cat {outside / 'a.py'}"}, str(outside)
            ))

    def test_enforce_query_order_denies_source_read_for_enabled_opted_in_root(self):
        root = self.tempdir / "enabled"
        source = root / "src" / "a.py"
        source.parent.mkdir(parents=True)
        source.write_text("print('hello')\n")
        enforce = self.write_json("enforce.json", {str(root): True})
        payload = {"cwd": str(root / "src"), "tool_name": "Read", "tool_input": {"file_path": str(source)}}

        with self.load_with(enforce):
            hook = load_hook()
            with mock.patch.object(hook, "state_for", return_value=("test-session", {})), \
                 mock.patch.object(hook, "save_for"), \
                 mock.patch.object(hook, "emit_discipline"), \
                 mock.patch.object(hook, "deny_pretool", side_effect=SystemExit(2)):
                with self.assertRaises(SystemExit) as raised:
                    hook.enforce_query_order(payload)
            self.assertEqual(raised.exception.code, 2)

    def test_enforce_query_order_denies_grep_for_enabled_opted_in_root(self):
        root = self.tempdir / "enabled"
        root.mkdir()
        enforce = self.write_json("enforce.json", {str(root): True})
        payload = {"cwd": str(root), "tool_name": "Grep", "tool_input": {"path": str(root)}}

        with self.load_with(enforce):
            hook = load_hook()
            with mock.patch.object(hook, "state_for", return_value=("test-session", {})), \
                 mock.patch.object(hook, "save_for"), \
                 mock.patch.object(hook, "emit_discipline"), \
                 mock.patch.object(hook, "deny_pretool", side_effect=SystemExit(2)):
                with self.assertRaises(SystemExit) as raised:
                    hook.enforce_query_order(payload)
            self.assertEqual(raised.exception.code, 2)

    def test_enforce_query_order_allows_source_read_for_disabled_opted_in_root(self):
        root = self.tempdir / "disabled"
        source = root / "src" / "a.py"
        source.parent.mkdir(parents=True)
        source.write_text("print('hello')\n")
        enforce = self.write_json("enforce.json", {str(root): False})
        payload = {"cwd": str(root / "src"), "tool_name": "Read", "tool_input": {"file_path": str(source)}}

        with self.load_with(enforce):
            hook = load_hook()
            with mock.patch.object(hook, "allow_pretool", side_effect=SystemExit(0)):
                with self.assertRaises(SystemExit) as raised:
                    hook.enforce_query_order(payload)
            self.assertEqual(raised.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
