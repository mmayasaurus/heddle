"""Tests for the fail-open SessionStart preflight hook (stdlib unittest only)."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


_HERE = Path(__file__).resolve()
MODULE_PATH = _HERE.with_name("agent-preflight.py")
if not MODULE_PATH.exists():
    MODULE_PATH = _HERE.parent.parent / "agent-preflight.py"
SPEC = importlib.util.spec_from_file_location("agent_preflight", MODULE_PATH)
if not (SPEC and SPEC.loader):
    raise ImportError("cannot load agent-preflight.py")
preflight = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = preflight
SPEC.loader.exec_module(preflight)


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        timeout=2,
        check=True,
    )
    return result.stdout.strip()


class PreflightFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.config = self.home / ".claude-acct4"
        self.config.mkdir(parents=True)
        (self.config / "CLAUDE.md").write_text("# fleet brain\n")
        registry = self.home / ".heddle" / "accounts.json"
        registry.parent.mkdir(parents=True)
        registry.write_text(json.dumps({"claude": [
            {"id": "acct4", "configDir": str(self.config)},
        ]}))

        self.canon = self.root / "heddle"
        self.canon.mkdir()
        git(self.canon, "init", "-q")
        git(self.canon, "config", "user.email", "test@example.invalid")
        git(self.canon, "config", "user.name", "Test")
        (self.canon / "file").write_text("one\n")
        git(self.canon, "add", "file")
        git(self.canon, "commit", "-qm", "first")
        self.origin = git(self.canon, "rev-parse", "HEAD")
        git(self.canon, "update-ref", "refs/remotes/origin/main", self.origin)
        self.marker = self.root / "marker"
        self.marker.write_text(self.origin[:8] + "\n")
        self.pack_one = self.root / "packs-one"
        self.pack_two = self.root / "packs-two"
        self.pack_one.mkdir()
        self.pack_two.mkdir()
        self.transcript = self.root / "transcript.jsonl"
        self.transcript.write_text(json.dumps({
            "type": "custom-title", "customTitle": "U",
        }) + "\n")
        self.env = {
            "HOME": str(self.home),
            "CLAUDE_CONFIG_DIR": str(self.config),
            "HEDDLE_CANON": str(self.canon),
            "HEDDLE_MEMTRACE_MARKER": str(self.marker),
            "HEDDLE_PACKS": os.pathsep.join((str(self.pack_one), str(self.pack_two))),
        }
        self.healthy_argv = (
            'claude --mcp-config {"HEDDLE_COMMS_PUSH":"1","mcpServers":{"heddle-comms":{}}} '
            '--dangerously-load-development-channels server:heddle-comms'
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def healthy_results(self):
        with mock.patch.object(preflight.socket, "create_connection", return_value=object()):
            return preflight.collect_results(
                {"session_id": "healthy", "transcript_path": str(self.transcript), "cwd": str(self.root)},
                env=self.env,
                home=str(self.home),
                comms_argv=self.healthy_argv,
            )


class TestHealthySession(PreflightFixture):
    def test_healthy_session_has_zero_fails(self) -> None:
        results = self.healthy_results()
        self.assertEqual({
            "brain": "OK", "memtrace": "OK", "fresh": "OK", "comms": "OK",
            "account": "OK", "identity": "OK", "packs": "OK",
        }, {result.name: result.status for result in results})
        banner = preflight.render_banner(results)
        self.assertIn("PREFLIGHT OK", banner)
        self.assertNotIn("ISSUE", banner)


class TestChannelProbePortParity(unittest.TestCase):
    def probe(self, ppid, argv):
        return preflight.channel_loaded_from_parent_argv(ppid, lambda _pid: argv)

    def test_loaded_cases(self) -> None:
        for argv in (
            "claude --dangerously-load-development-channels server:heddle-comms",
            "claude --dangerously-load-development-channels=server:heddle-comms",
            "claude --dangerously-load-development-channels plugin:heddle-comms@x",
        ):
            with self.subTest(argv=argv):
                self.assertIs(self.probe(42, argv), True)

    def test_non_claude_or_invalid_is_unknown(self) -> None:
        self.assertIsNone(self.probe(42, 'bash -lc "x claude y"'))
        self.assertIsNone(self.probe(1.5, "claude --print hello"))
        for value in (None, "", "node dist/..."):
            with self.subTest(value=value):
                self.assertIsNone(self.probe(42, value))
        self.assertIsNone(preflight.channel_loaded_from_parent_argv(
            42, lambda _pid: (_ for _ in ()).throw(RuntimeError("no argv"))))

    def test_claude_without_the_channel_flag_is_false(self) -> None:
        for argv in (
            "/usr/bin/claude --resume x",
            "claude.exe --resume x",
            "claude --print hello",
            "claude --dangerously-load-development-channels server:other-channel",
            "claude --dangerously-load-development-channels server:other-heddle-comms",
            "claude --dangerously-load-development-channels server:heddle-comms-copy",
            "claude --dangerously-load-development-channels --foo",
            "claude --dangerously-load-development-channels",
        ):
            with self.subTest(argv=argv):
                self.assertIs(self.probe(42, argv), False)


class TestCommsDiscriminator(unittest.TestCase):
    def test_false_with_configured_comms_fails(self) -> None:
        argv = 'claude --mcp-config {"HEDDLE_COMMS_PUSH":"1","mcpServers":{"heddle-comms":{}}} --resume x'
        result = preflight.probe_comms({}, comms_argv=argv)
        self.assertEqual("FAIL", result.status)

    def test_false_without_configured_comms_skips(self) -> None:
        pull_argv = 'claude --mcp-config {"mcpServers":{"heddle-comms":{}}} --resume x'
        result = preflight.probe_comms({}, comms_argv=pull_argv)
        self.assertEqual("SKIP", result.status)
        result = preflight.probe_comms({}, comms_argv="claude --resume x")
        self.assertEqual("SKIP", result.status)
        result = preflight.probe_comms(
            {"FLEET_COMMS": "off"},
            comms_argv='claude --mcp-config {"HEDDLE_COMMS_PUSH":"1","mcpServers":{"heddle-comms":{}}} --resume x',
        )
        self.assertEqual("SKIP", result.status)

    def test_unknown_channel_probe_skips(self) -> None:
        result = preflight.probe_comms({}, comms_argv="node dist/...")
        self.assertEqual("SKIP", result.status)


class TestProbeFaultAndSkipPaths(PreflightFixture):
    def test_brain_missing_and_empty_fail(self) -> None:
        missing = preflight.probe_brain({"CLAUDE_CONFIG_DIR": str(self.root / "missing")})
        self.assertEqual("FAIL", missing.status)
        (self.config / "CLAUDE.md").write_text("")
        empty = preflight.probe_brain({"CLAUDE_CONFIG_DIR": str(self.config)})
        self.assertEqual("FAIL", empty.status)

    def test_unreachable_memtrace_fails(self) -> None:
        with mock.patch.object(
            preflight.socket, "create_connection", side_effect=ConnectionRefusedError
        ):
            result = preflight.probe_memtrace_reachable(port=59999)
        self.assertEqual("FAIL", result.status)

    def test_stale_marker_fails_with_behind_count(self) -> None:
        (self.canon / "file").write_text("two\n")
        git(self.canon, "add", "file")
        git(self.canon, "commit", "-qm", "second")
        newer = git(self.canon, "rev-parse", "HEAD")
        git(self.canon, "update-ref", "refs/remotes/origin/main", newer)
        result = preflight.probe_memtrace_fresh(self.env)
        self.assertEqual("FAIL", result.status)
        self.assertIn("1 commits behind", result.detail)

    def test_account_missing_registry_and_no_match_fail(self) -> None:
        (self.home / ".heddle" / "accounts.json").unlink()
        self.assertEqual("FAIL", preflight.probe_account(self.env, home=str(self.home)).status)
        (self.home / ".heddle" / "accounts.json").write_text(json.dumps({"claude": []}))
        self.assertEqual("FAIL", preflight.probe_account(self.env, home=str(self.home)).status)

    def test_identity_conflict_fails(self) -> None:
        env = dict(self.env, HEDDLE_AGENT="X")
        result = preflight.probe_identity(
            env, {"session_id": "s", "transcript_path": str(self.transcript)}, home=str(self.home))
        self.assertEqual("FAIL", result.status)

    def test_identity_prefers_heddle_agent_and_falls_back_to_fleet_agent(self) -> None:
        payload = {"session_id": "s", "transcript_path": str(self.transcript)}
        self.assertEqual(
            "OK", preflight.probe_identity(dict(self.env, HEDDLE_AGENT="U"), payload, home=str(self.home)).status)
        fallback = preflight.probe_identity(dict(self.env, FLEET_AGENT="X"), payload, home=str(self.home))
        self.assertEqual("FAIL", fallback.status)
        self.assertIn("HEDDLE_AGENT=X", fallback.remediation)

    def test_identity_unknown_and_packs_unset_skip(self) -> None:
        result = preflight.probe_identity(self.env, {"session_id": "missing"}, home=str(self.home))
        self.assertEqual("SKIP", result.status)
        env_without_packs = {key: value for key, value in self.env.items() if key != "HEDDLE_PACKS"}
        self.assertEqual("SKIP", preflight.probe_heddle_packs(env_without_packs).status)

    def test_invalid_heddle_packs_fails(self) -> None:
        result = preflight.probe_heddle_packs(dict(self.env, HEDDLE_PACKS=str(self.root / "missing-packs")))
        self.assertEqual("FAIL", result.status)

    def test_multiple_heddle_packs_are_a_search_path(self) -> None:
        both = os.pathsep.join((str(self.pack_one), str(self.pack_two)))
        self.assertEqual("OK", preflight.probe_heddle_packs({"HEDDLE_PACKS": both}).status)
        trailing = both + os.pathsep
        self.assertEqual("OK", preflight.probe_heddle_packs({"HEDDLE_PACKS": trailing}).status)
        missing = os.pathsep.join((str(self.pack_one), str(self.root / "no-pack")))
        self.assertEqual("FAIL", preflight.probe_heddle_packs({"HEDDLE_PACKS": missing}).status)

    def test_non_git_canon_and_transient_marker_verification_skip(self) -> None:
        self.assertEqual(
            "SKIP", preflight.probe_memtrace_fresh({"HEDDLE_CANON": str(self.root / "not-repo")}).status)
        with mock.patch.object(preflight, "_git", side_effect=[self.origin, None]):
            result = preflight.probe_memtrace_fresh(self.env)
        self.assertEqual("SKIP", result.status)

    def test_account_default_config_dir_null_matches(self) -> None:
        default_config = self.home / ".claude"
        default_config.mkdir()
        (self.home / ".heddle" / "accounts.json").write_text(json.dumps({"claude": [
            {"id": "default", "configDir": None},
        ]}))
        env = {key: value for key, value in self.env.items() if key != "CLAUDE_CONFIG_DIR"}
        result = preflight.probe_account(env, home=str(self.home))
        self.assertEqual("OK", result.status)
        self.assertEqual("default", result.detail)

    def test_identity_cache_and_transcript_precedence(self) -> None:
        cache = self.home / ".claude" / "fleet-identity-cache"
        cache.mkdir(parents=True)
        (cache / "s.label").write_text("X")
        env = dict(self.env, HEDDLE_AGENT="U")
        result = preflight.probe_identity(
            env, {"session_id": "s", "transcript_path": str(self.transcript)}, home=str(self.home))
        self.assertEqual("OK", result.status)
        self.assertEqual("U", result.detail)
        (cache / "cache-only.label").write_text("U")
        result = preflight.probe_identity(env, {"session_id": "cache-only"}, home=str(self.home))
        self.assertEqual("OK", result.status)

    def test_identity_ignores_stale_and_path_traversal_cache_entries(self) -> None:
        cache = self.home / ".claude" / "fleet-identity-cache"
        cache.mkdir(parents=True)
        stale = cache / "stale.label"
        stale.write_text("U")
        old = time.time() - 24 * 3600 - 1
        os.utime(stale, (old, old))
        self.assertIsNone(preflight.fleet_label("stale", home=str(self.home)))
        self.assertIsNone(preflight.fleet_label("../outside", home=str(self.home)))

    def test_mcp_config_equals_and_file_path_detect_push_intent(self) -> None:
        inline = 'claude --mcp-config={"HEDDLE_COMMS_PUSH":"1"} --resume x'
        self.assertTrue(preflight.push_intended(inline, {}))
        config = self.root / "mcp.json"
        config.write_text('{"HEDDLE_COMMS_PUSH":"1"}')
        self.assertTrue(preflight.push_intended(f"claude --mcp-config {config} --resume x", {}))
        self.assertFalse(preflight.push_intended(
            f"claude --mcp-config {config.with_name('missing.json')} -p HEDDLE_COMMS_PUSH", {}))

    def test_find_claude_parent_walks_wrappers_and_bool_ppid_is_unknown(self) -> None:
        argv_by_pid = {10: "sh wrapper", 9: "bash wrapper", 8: "claude --resume x"}
        with mock.patch.object(preflight.os, "getppid", return_value=10), \
                mock.patch.object(preflight, "_parent_pid", side_effect=[9, 8]):
            self.assertEqual(8, preflight.find_claude_parent(lambda pid: argv_by_pid.get(pid)))
        self.assertIsNone(preflight.channel_loaded_from_parent_argv(True, lambda _pid: "claude"))


class TestFailOpen(PreflightFixture):
    def test_preflight_budget_skips_remaining_probes(self) -> None:
        with mock.patch.object(
            preflight.time, "monotonic", side_effect=[0.0, 0.0] + [3.1] * 10
        ):
            results = preflight.collect_results(
                {}, env=self.env, probes={"brain": lambda: preflight.ProbeResult("brain", "OK")})
        self.assertEqual("OK", results[0].status)
        for result in results[1:]:
            self.assertEqual("SKIP", result.status)
            self.assertIn("budget", result.detail)
        self.assertFalse(any(result.status == "FAIL" for result in results))

    def test_raising_probe_becomes_skip_not_fail(self) -> None:
        results = preflight.collect_results(
            {"session_id": "s", "transcript_path": str(self.transcript)},
            env=self.env,
            home=str(self.home),
            comms_argv=self.healthy_argv,
            probes={"brain": lambda: (_ for _ in ()).throw(RuntimeError("boom"))},
        )
        brain = next(result for result in results if result.name == "brain")
        self.assertEqual("SKIP", brain.status)
        self.assertNotEqual("FAIL", brain.status)

    def test_broken_stdin_emits_empty_object_and_exits_zero(self) -> None:
        output = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO("not json")), \
                contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                preflight.main()
        self.assertEqual(0, raised.exception.code)
        self.assertEqual("{}", output.getvalue().strip())

    def test_outer_failure_also_emits_empty_object_and_exits_zero(self) -> None:
        output = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO("{}")), \
                mock.patch.object(preflight, "collect_results", side_effect=RuntimeError("boom")), \
                contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                preflight.main()
        self.assertEqual(0, raised.exception.code)
        self.assertEqual("{}", output.getvalue().strip())

    def test_keyboard_interrupt_emits_empty_object_and_exits_zero(self) -> None:
        output = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO("{}")), \
                mock.patch.object(preflight, "collect_results", side_effect=KeyboardInterrupt), \
                contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                preflight.main()
        self.assertEqual(0, raised.exception.code)
        self.assertEqual("{}", output.getvalue().strip())

    def test_non_dict_stdin_emits_empty_object_and_exits_zero(self) -> None:
        for payload in ("[]", "1"):
            with self.subTest(payload=payload):
                output = io.StringIO()
                with mock.patch.object(sys, "stdin", io.StringIO(payload)), \
                        contextlib.redirect_stdout(output):
                    with self.assertRaises(SystemExit) as raised:
                        preflight.main()
                self.assertEqual(0, raised.exception.code)
                self.assertEqual("{}", output.getvalue().strip())

    def test_non_probe_result_degrades_to_skip(self) -> None:
        results = preflight.collect_results(
            {}, env=self.env, probes={"brain": lambda: "not a probe result"})
        brain = next(result for result in results if result.name == "brain")
        self.assertEqual("SKIP", brain.status)


if __name__ == "__main__":
    unittest.main()
