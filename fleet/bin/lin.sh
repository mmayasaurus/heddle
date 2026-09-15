#!/usr/bin/env python3
"""lin.sh — fleet CLI for the Linear issue tracker (team SPI by default; LIN_TEAM=HED for the heddle fleet).

Every Claude/Codex instance acts in Linear AS ITSELF (its own OAuth agent
actor), so claims/comments are visibly attributed ("Agent F", "Codex B").

IDENTITY RESOLUTION (first hit wins):
  1. --agent <K>                 (K = A..L for Claude, codex-A..codex-E for Codex)
  2. $FLEET_AGENT                (set at launch, e.g. in the Codex wrapper)
  3. .fleet-agent file           (at git toplevel or any parent of cwd — pin a
                                  worktree to an identity by writing the key there)
If none resolve: hard error. NEVER guess an identity.

COMMANDS
  lin.sh whoami                          resolved identity + live Linear check
  lin.sh list [--area X] [--limit N]     unclaimed ready work (Backlog/Todo), priority-first
  lin.sh areas                           Area buckets with open-issue counts (for batch claiming)
  lin.sh view SPI-12                     full issue: state/prio/labels/delegate/branch/desc/comments
  lin.sh claim SPI-12 [SPI-13 ...]       collision-safe claim: delegate=me, state->In Progress, comment
  lin.sh mine                            issues currently delegated to me
  lin.sh comment SPI-12 <text...>        progress note (attributed to me)
  lin.sh resolve SPI-12 <text...>        resolution comment ONLY (PR merge auto-moves to Done)
  lin.sh done SPI-12 <text...>           resolution comment + state->Done (no-PR issues only)
  lin.sh unclaim SPI-12 [reason...]      release: delegate cleared, state->Todo, comment
  lin.sh needs-maya SPI-12 "<ask>"       label + decision marker comment for Maya
  lin.sh needs-maya list                 local open decision queue, stalest first
  lin.sh create <title> [--desc D] [--type T] [--area A] [--platform P] [--priority 1-4]

EXIT CODES: 0 ok · 1 error · 2 stand-down (issue actively claimed by another agent) OR fleet-scope refusal (a heddle-fleet identity acting on a team-SPI issue — claim/resolve/done/needs-maya — or creating in team SPI; .claude/rules/fleet-scope.md)

Credentials: ~/.claude/spinventory-fleet/linear-agents.json (never in a repo).
Tokens auto-mint/refresh; nothing here needs Maya's login.

GitHub tracker support: `tracker: github` requires both `githubRepo` and `linearTeam` in
~/.heddle/projects.json.
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _linear_token_cache

FLEET = pathlib.Path(os.path.expanduser("~/.claude/spinventory-fleet"))
CREDS = FLEET / "linear-agents.json"
TEAM_KEY = os.environ.get("LIN_TEAM", "SPI").strip() or "SPI"  # export LIN_TEAM=HED for heddle work
FLEET_SCOPE_RULE = ".claude/rules/fleet-scope.md"   # HED-355 — Maya, firsthand 2026-08-23: fleet is heddle-only
APP_TEAM_KEY = "SPI"                                  # the Spinventory app team — off-limits to this fleet
HEDDLE_FLEET = frozenset("RSTUVWXYZ")  # heddle-fleet identities bound by fleet-scope.md (R, S–X; Y/Z reserved) — keep identical to HEDDLE_FLEET in .claude/hooks/agent-identity.py and .claude/hooks/remind-owned-prs.py (test_lin_scope_guard.py asserts the three agree)
SCOPE = "read,write,issues:create,comments:create,app:assignable,app:mentionable"
API = "https://api.linear.app/graphql"
NEEDS_MAYA = FLEET / "needs-maya.json"


# ---------- identity ----------

def resolve_agent(cli_agent):
    if cli_agent:
        return normalize_key(cli_agent)
    env = os.environ.get("FLEET_AGENT", "").strip()
    if env:
        return normalize_key(env)
    d = pathlib.Path.cwd()
    for p in [d, *d.parents]:
        f = p / ".fleet-agent"
        if f.is_file():
            v = f.read_text().strip()
            if v:
                return normalize_key(v)
    sys.exit("lin.sh: no identity. Pass --agent <A..P|1..6|codex-A..E>, set FLEET_AGENT, "
             "or write the key to a .fleet-agent file at your worktree root. Never guess.")


def normalize_key(k):
    k = k.strip()
    kl = k.lower()
    if kl.startswith("codex"):
        tail = kl.replace("codex", "").strip("-_ ").upper()
        key = f"codex-{tail}"
    else:
        key = k.upper()
    creds = load_creds()
    if key not in creds["agents"]:
        sys.exit(f"lin.sh: unknown agent key {key!r}. Known: {', '.join(sorted(creds['agents']))}")
    return key


def load_creds():
    if not CREDS.exists():
        sys.exit(f"lin.sh: {CREDS} missing — Linear agent credentials not set up on this machine.")
    return json.load(open(CREDS))


def get_token(key):
    def mint():
        a = load_creds()["agents"][key]
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials", "client_id": a["client_id"],
            "client_secret": a["client_secret"], "scope": SCOPE}).encode()
        req = urllib.request.Request("https://api.linear.app/oauth/token", data=body,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        return json.load(urllib.request.urlopen(req))

    return _linear_token_cache.get_or_mint_token(FLEET, key, mint)


# ---------- api ----------

class Tracker:
    @property
    def me(self):
        raise NotImplementedError

    def issue(self, ident):
        raise NotImplementedError

    def list_issues(self, *, mine: bool, area: str | None, me_id: str, limit: int) -> list[dict]:
        raise NotImplementedError

    def area_counts(self) -> list[tuple[str, int]]:
        raise NotImplementedError

    def create_issue(self, *, title: str, type_label: str, area: str | None, platform: str | None,
                     desc: str | None, priority: int | None) -> dict:
        raise NotImplementedError

    def flag_for_human(self, issue: dict, agent_key: str, ask: str) -> bool:
        raise NotImplementedError

    def states(self, team_key=None):
        raise NotImplementedError

    def state_by(self, *, type=None, name=None, team_key=None):
        raise NotImplementedError

    def labels(self):
        raise NotImplementedError

    def update(self, issue_id, **fields):
        raise NotImplementedError

    def comment(self, issue_id, body):
        raise NotImplementedError


class Lin:
    def __init__(self, key):
        self.key = key
        self.token = get_token(key)
        self._me = None
        self._states_by_team = {}
        self._labels = None

    def gql(self, query, variables=None, retries=3):
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        for attempt in range(retries):
            try:
                req = urllib.request.Request(API, data=body, headers={
                    "Authorization": f"Bearer {self.token}",
                    "Content-Type": "application/json"})
                out = json.load(urllib.request.urlopen(req))
                if out.get("errors"):
                    raise RuntimeError("; ".join(e.get("message", "?") for e in out["errors"]))
                return out["data"]
            except urllib.error.HTTPError as e:
                detail = ""
                try:
                    detail = "; ".join(err.get("message", "?")
                                       for err in json.load(e).get("errors", []))
                except Exception:
                    pass
                if e.code == 400 or attempt == retries - 1:
                    sys.exit(f"lin.sh: Linear API error {e.code}: {detail or e.reason}")
                time.sleep(2)
            except Exception:
                if attempt == retries - 1:
                    raise
                time.sleep(2)

    @property
    def me(self):
        if self._me is None:
            self._me = self.gql("{ viewer { id name } }")["viewer"]
        return self._me

    def states(self, team_key=None):
        tk = team_key or TEAM_KEY
        if tk not in self._states_by_team:
            d = self.gql('{ workflowStates(filter:{team:{key:{eq:"%s"}}}) '
                         '{ nodes { id name type } } }' % tk)
            self._states_by_team[tk] = d["workflowStates"]["nodes"]
        return self._states_by_team[tk]

    def state_by(self, *, type=None, name=None, team_key=None):
        for s in self.states(team_key):
            if name and s["name"] == name:
                return s
        for s in self.states(team_key):
            if type and s["type"] == type:
                return s
        sys.exit(f"lin.sh: no workflow state matching type={type} name={name}")

    def labels(self):
        if self._labels is None:
            d = self.gql("{ issueLabels(first: 250) { nodes { id name parent { name } team { id } } } }")
            self._labels = d["issueLabels"]["nodes"]
        return self._labels

    def issue(self, ident):
        d = self.gql("""query($id: String!) { issue(id: $id) {
            id identifier title url branchName priority priorityLabel description
            team { id key } state { id name type } delegate { id name } assignee { id name }
            labels { nodes { id name } }
            comments(last: 6) { nodes { body createdAt
                user { name } botActor { name } externalUser { name } } }
        } }""", {"id": ident})
        if not d.get("issue"):
            sys.exit(f"lin.sh: issue {ident} not found")
        return d["issue"]

    def update(self, issue_id, **fields):
        return self.gql("""mutation($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success } }""",
            {"id": issue_id, "input": fields})

    def comment(self, issue_id, body):
        return self.gql("""mutation($input: CommentCreateInput!) {
            commentCreate(input: $input) { success } }""",
            {"input": {"issueId": issue_id, "body": body}})


class LinearTracker(Tracker):
    """Tracker backed by the Linear GraphQL client. Delegates issue/me/state/comment to an
    unchanged Lin instance and implements list_issues/area_counts/create_issue/flag_for_human
    with the same GraphQL those commands used before HED-408 phase 2a routed them here."""

    def __init__(self, key):
        self._linear = Lin(key)

    @property
    def key(self):
        return self._linear.key

    @property
    def me(self):
        return self._linear.me

    def issue(self, ident):
        return self._linear.issue(ident)

    def list_issues(self, *, mine: bool, area: str | None, me_id: str, limit: int) -> list[dict]:
        f = {"team": {"key": {"eq": TEAM_KEY}}}
        if mine:
            f["delegate"] = {"id": {"eq": me_id}}
            f["state"] = {"type": {"in": ["backlog", "unstarted", "started"]}}
        else:
            f["delegate"] = {"null": True}
            f["state"] = {"type": {"in": ["backlog", "unstarted"]}}
        if area:
            f["labels"] = {"name": {"eq": area}}
        d = self._linear.gql("""query($f: IssueFilter, $n: Int) {
            issues(filter: $f, first: $n) { nodes {
                identifier title priority priorityLabel state { name }
                labels { nodes { name parent { name } } } delegate { name } } } }""",
            {"f": f, "n": max(limit, 100)})
        nodes = d["issues"]["nodes"]
        nodes.sort(key=lambda i: i["priority"] if i["priority"] > 0 else 99)
        return [{
            "identifier": i["identifier"],
            "title": i["title"],
            "priorityLabel": i["priorityLabel"],
            "area": next((l["name"] for l in i["labels"]["nodes"]
                          if (l.get("parent") or {}).get("name") == "Area"), "-"),
            "state_name": i["state"]["name"],
            "delegate_name": i["delegate"]["name"] if i["delegate"] else None,
        } for i in nodes[:limit]]

    def area_counts(self) -> list[tuple[str, int]]:
        area_labels = [l for l in self._linear.labels()
                       if (l.get("parent") or {}).get("name") == "Area"]
        counts = []
        for l in sorted(area_labels, key=lambda x: x["name"]):
            d = self._linear.gql("""query($f: IssueFilter) { issues(filter: $f, first: 1) {
                nodes { id } } issueCount: issues(filter: $f, first: 250) { nodes { id } } }""",
                {"f": {"team": {"key": {"eq": TEAM_KEY}},
                       "labels": {"name": {"eq": l["name"]}},
                       "state": {"type": {"in": ["backlog", "unstarted", "started"]}}}})
            counts.append((l["name"], len(d["issueCount"]["nodes"])))
        return counts

    def create_issue(self, *, title: str, type_label: str, area: str | None, platform: str | None,
                     desc: str | None, priority: int | None) -> dict:
        labels = self._linear.labels()

        def lid(name, group):
            for l in labels:
                if l["name"].lower() == name.lower() and (l.get("parent") or {}).get("name") == group:
                    return l["id"]
            sys.exit(f"lin.sh: no {group} label named {name!r}")

        label_ids = [lid(type_label, "Type")]
        if area:
            label_ids.append(lid(area, "Area"))
        if platform:
            label_ids.append(lid(platform, "Platform"))
        team = self._linear.gql('{ teams(filter:{key:{eq:"%s"}}) { nodes { id } } }' % TEAM_KEY)
        inp = {"teamId": team["teams"]["nodes"][0]["id"], "title": title, "labelIds": label_ids}
        if desc:
            inp["description"] = desc
        if priority:
            inp["priority"] = priority
        d = self._linear.gql("""mutation($input: IssueCreateInput!) {
            issueCreate(input: $input) { issue { identifier url } } }""", {"input": inp})
        return d["issueCreate"]["issue"]

    def flag_for_human(self, issue: dict, agent_key: str, ask: str) -> bool:
        # needs-maya is a WORKSPACE-level label (teamId=null). A non-admin fleet agent CANNOT create a
        # team-scoped label — Linear returns "not allowed to create labels in this team" (verified live
        # 2026-08-21) — but CAN create a workspace label, which coexists across SPI + HED and is exactly
        # the cross-team state flag we want. Accept ONLY a workspace-level match (never a same-name team
        # label — that would defeat the contract and can fail issueAddLabel for issues in other teams);
        # create workspace-level (no teamId) when none exists.
        labels = self._linear.gql("""query {
            issueLabels(filter:{ name:{ eq:"needs-maya" } }, first:50) {
                nodes { id name team { id } }
            }
        }""")["issueLabels"]["nodes"]
        label = next((l for l in labels if l.get("team") is None), None)
        if label is None:
            created = self._linear.gql("""mutation($input: IssueLabelCreateInput!) {
                issueLabelCreate(input: $input) { success issueLabel { id name } }
            }""", {"input": {"name": "needs-maya"}})["issueLabelCreate"]
            label = created.get("issueLabel")
            if not created.get("success") or not label:
                sys.exit("lin.sh: could not create the needs-maya label")

        label_ids = [label["id"] for label in issue["labels"]["nodes"]]
        if label["id"] not in label_ids:
            self._linear.gql("""mutation($id: String!, $lid: String!) {
                issueAddLabel(id: $id, labelId: $lid) { success } }""",
                {"id": issue["id"], "lid": label["id"]})
        # Return a NEUTRAL bool, not the Linear commentCreate envelope — cmd_needs_maya and phase-2b's
        # GitHubIssuesTracker must both satisfy the same contract (HED-408 phase-2a review).
        result = self._linear.comment(issue["id"], f"🔶 DECISION NEEDED (Agent {agent_key})\n{ask}")
        return bool(result.get("commentCreate", {}).get("success"))

    def states(self, team_key=None):
        return self._linear.states(team_key)

    def state_by(self, *, type=None, name=None, team_key=None):
        return self._linear.state_by(type=type, name=name, team_key=team_key)

    def labels(self):
        return self._linear.labels()

    def update(self, issue_id, **fields):
        return self._linear.update(issue_id, **fields)

    def comment(self, issue_id, body):
        return self._linear.comment(issue_id, body)

    def __getattr__(self, name):
        return getattr(self._linear, name)


class GitHubIssuesTracker(Tracker):
    """Tracker backed by repository GitHub Issues via the gh CLI."""

    _STATES = [
        {"id": "gh:unstarted", "name": "Todo", "type": "unstarted"},
        {"id": "gh:started", "name": "In Progress", "type": "started"},
        {"id": "gh:completed", "name": "Done", "type": "completed"},
    ]
    _PRIORITY_LABELS = {1: "Urgent", 2: "High", 3: "Medium", 4: "Low"}

    def __init__(self, key, repo, team_key):
        self._key = key
        self._repo = repo
        self._team_key = team_key
        self._label_names = None

    @property
    def key(self):
        return self._key

    @property
    def me(self):
        return {"id": self._key, "name": f"Agent {self._key}"}

    def _gh(self, args, *, repo=True, input=None, parse_json=True):
        cmd = ["gh", *args]
        if repo:
            cmd.extend(["-R", self._repo])
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, input=input)
        except FileNotFoundError:
            sys.exit("lin.sh: gh CLI not found — install and authenticate gh")
        if result.returncode:
            sys.exit(f"lin.sh: gh {' '.join(args)} failed: {result.stderr.strip() or result.returncode}")
        return json.loads(result.stdout or "null") if parse_json else result.stdout

    @staticmethod
    def _num(ident):
        s = str(ident).strip()
        match = re.search(r"/issues/(\d+)", s) or re.search(r"(?:^|#)(\d+)$", s)
        if not match:
            sys.exit(f"lin.sh: invalid GitHub issue identifier {ident!r}")
        return match.group(1)

    @classmethod
    def _priority(cls, labels):
        for label in labels:
            match = re.fullmatch(r"priority:\s*(\d+)", label.get("name", ""))
            if match:
                return int(match.group(1))
        return 0

    @staticmethod
    def _state_of(state, labels):
        if isinstance(state, dict):
            state = state.get("name") or state.get("state")
        if str(state or "").upper() == "CLOSED":
            return {"id": "gh:completed", "name": "Done", "type": "completed"}
        if any(label.get("name") == "status: in-progress" for label in labels):
            return {"id": "gh:started", "name": "In Progress", "type": "started"}
        return {"id": "gh:unstarted", "name": "Todo", "type": "unstarted"}

    def _branch(self, number, title):
        slug = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")[:48]
        return f"agent{self._key}/{number}-{slug}"

    def issue(self, ident):
        number = self._num(ident)
        data = self._gh(["issue", "view", number, "--json",
                         "number,title,body,url,state,labels,assignees,comments"])
        labels = data.get("labels") or []
        assignees = data.get("assignees") or []
        assignee = None
        if assignees:
            login = assignees[0].get("login")
            if login:
                assignee = {"id": login, "name": login}
        delegate = None
        for label in labels:
            name = label.get("name", "")
            if name.startswith("delegate: "):
                agent_key = name[len("delegate: "):]
                delegate = {"id": agent_key, "name": f"Agent {agent_key}"}
                break
        priority = self._priority(labels)
        comments_src = (data.get("comments") or [])[-6:]
        return {
            "id": str(data["number"]),
            "identifier": f"#{data['number']}",
            "title": data["title"],
            "url": data["url"],
            "branchName": self._branch(data["number"], data["title"]),
            "priority": priority,
            "priorityLabel": self._PRIORITY_LABELS.get(priority, "No priority"),
            "description": data.get("body") or "",
            "state": self._state_of(data.get("state"), labels),
            "delegate": delegate,
            "assignee": assignee,
            "labels": {"nodes": [{"id": label["name"], "name": label["name"]}
                                  for label in labels]},
            "team": {"id": None, "key": self._team_key},
            "comments": {"nodes": [
                {"body": comment["body"], "createdAt": comment["createdAt"],
                 "user": {"name": (comment.get("author") or {}).get("login") or "?"},
                 "botActor": None, "externalUser": None}
                for comment in comments_src
            ]},
        }

    def states(self, team_key=None):
        return list(self._STATES)

    def state_by(self, *, type=None, name=None, team_key=None):
        for state in self._STATES:
            if name and state["name"] == name:
                return state
        for state in self._STATES:
            if type and state["type"] == type:
                return state
        sys.exit(f"lin.sh: no workflow state matching type={type} name={name}")

    def _labels_for(self, number):
        return self._gh(["issue", "view", number, "--json", "labels"]).get("labels") or []

    def _is_closed(self, number):
        state = self._gh(["issue", "view", number, "--json", "state"]).get("state")
        if isinstance(state, dict):
            state = state.get("name") or state.get("state")
        return str(state or "").upper() == "CLOSED"

    def _clear_status(self, number):
        for label in self._labels_for(number):
            name = label.get("name", "")
            if name.startswith("status: "):
                self._gh(["issue", "edit", number, "--remove-label", name], parse_json=False)

    def _ensure_label(self, name):
        if self._label_names is None:
            labels = self._gh(["label", "list", "--limit", "1000", "--json", "name"])
            self._label_names = [label["name"] for label in labels or []]
        # GitHub label names are case-insensitive-unique: reuse an existing case-variant rather than
        # attempting to create it (a create of a case-variant fails "already exists").
        for existing in self._label_names:
            if existing.lower() == name.lower():
                return existing
        self._gh(["label", "create", name], parse_json=False)
        self._label_names.append(name)
        return name

    def _clear_delegate(self, number, except_name=None):
        # Remove delegate labels, optionally sparing except_name so a same-agent re-claim never has a
        # window with its own delegate label missing (round-2 finding 1 — the lock-drop race: a
        # concurrent claim or a kill in the gap would otherwise see no owner).
        for label in self._labels_for(number):
            name = label.get("name", "")
            if name.startswith("delegate: ") and name != except_name:
                self._gh(["issue", "edit", number, "--remove-label", name], parse_json=False)

    def _set_status(self, number, status):
        self._clear_status(number)
        # Use the canonical casing _ensure_label resolves: `gh issue edit --add-label` is
        # case-sensitive, so a pre-existing case-variant (e.g. "Status: in-progress") must be added by
        # its real name, not the lowercase constructed one.
        name = self._ensure_label(f"status: {status}")
        self._gh(["issue", "edit", number, "--add-label", name], parse_json=False)

    def update(self, issue_id, **fields):
        number = self._num(issue_id)
        if "delegateId" in fields:
            delegate = fields["delegateId"]
            if delegate is None:
                self._clear_delegate(number)
                assignees = self._gh(["issue", "view", number, "--json", "assignees"]).get("assignees") or []
                for assignee in assignees:
                    login = assignee.get("login")
                    if login:
                        self._gh(["issue", "edit", number, "--remove-assignee", login], parse_json=False)
            else:
                # Resolve the canonical label casing first (add-label is case-sensitive), then spare
                # exactly that name when clearing and add it verbatim.
                name = self._ensure_label(f"delegate: {delegate}")
                self._clear_delegate(number, except_name=name)
                self._gh(["issue", "edit", number, "--add-label", name], parse_json=False)
                self._gh(["issue", "edit", number, "--add-assignee", "@me"], parse_json=False)
        if "stateId" in fields:
            state_id = fields["stateId"]
            if state_id == "gh:started":
                if self._is_closed(number):
                    self._gh(["issue", "reopen", number], parse_json=False)
                self._set_status(number, "in-progress")
            elif state_id == "gh:completed":
                self._set_status(number, "done")
                if not self._is_closed(number):
                    self._gh(["issue", "close", number], parse_json=False)
            elif state_id == "gh:unstarted":
                self._clear_status(number)
                if self._is_closed(number):
                    self._gh(["issue", "reopen", number], parse_json=False)
            else:
                sys.exit(f"lin.sh: unknown GitHub workflow state {state_id!r}")
        return {"success": True}

    def comment(self, issue_id, body):
        self._gh(["issue", "comment", self._num(issue_id), "--body", body], parse_json=False)
        return {"success": True}

    def list_issues(self, *, mine: bool, area: str | None, me_id: str, limit: int) -> list[dict]:
        if mine:
            args = ["issue", "list", "--state", "open", "--label", f"delegate: {me_id}"]
            if area:
                args.extend(["--label", f"Area: {area}"])
        else:
            search = 'is:open no:assignee -label:"status: in-progress"'
            if area:
                search += f' label:"Area: {area}"'
            args = ["issue", "list", "--search", search]
        args.extend(["--json", "number,title,labels,assignees,state", "--limit", str(max(limit, 100))])
        nodes = self._gh(args) or []
        rows = []
        for node in nodes:
            labels = node.get("labels") or []
            priority = self._priority(labels)
            rows.append({
                "identifier": f"#{node['number']}",
                "title": node["title"],
                "priorityLabel": self._PRIORITY_LABELS.get(priority, "No priority"),
                "area": next((label["name"][6:] for label in labels
                              if label.get("name", "").startswith("Area: ")), "-"),
                "state_name": "In Progress" if any(
                    label.get("name") == "status: in-progress" for label in labels) else "Todo",
                # Identity is the delegate:<letter> label, not the (shared) gh assignee login
                # (round-2 finding 2 — mine/list must show the fleet agent, not "mmayasaurus").
                "delegate_name": next((f"Agent {label['name'][len('delegate: '):]}"
                                       for label in labels
                                       if label.get("name", "").startswith("delegate: ")), None),
                "_priority": priority,
            })
        rows.sort(key=lambda row: row["_priority"] if row["_priority"] > 0 else 99)
        return [{key: value for key, value in row.items() if key != "_priority"}
                for row in rows[:limit]]

    def create_issue(self, *, title, type_label, area, platform, desc, priority):
        labels = self.labels()

        def label_name(value, group):
            # Accept either the bare taxonomy value ("Core") or the full label name ("Area: Core").
            prefix = f"{group}: "
            bare = value[len(prefix):] if value.lower().startswith(prefix.lower()) else value
            for label in labels:
                parent = (label.get("parent") or {}).get("name")
                if parent and parent.lower() == group.lower() and label["name"].lower() == bare.lower():
                    return label["id"]
            # Genuinely absent (no case-insensitive match in this group): create it, using the
            # canonical name _ensure_label resolves/returns.
            return self._ensure_label(f"{group}: {bare}")

        label_names = [label_name(type_label, "Type")]
        if area is not None:
            label_names.append(label_name(area, "Area"))
        if platform is not None:
            label_names.append(label_name(platform, "Platform"))
        if priority is not None:
            label_names.append(self._ensure_label(f"priority: {priority}"))
        args = ["issue", "create", "--title", title, "--body-file", "-"]
        for name in label_names:
            args.extend(["--label", name])
        url_out = self._gh(args, input=desc or "", parse_json=False)
        url = next((line.strip() for line in reversed(url_out.splitlines()) if line.strip()), None)
        if not url:
            sys.exit("lin.sh: gh issue create returned no URL")
        number = self._num(url)
        return {"identifier": f"#{number}", "url": url}

    def area_counts(self):
        area_labels = [label for label in self.labels()
                       if (label.get("parent") or {}).get("name") == "Area"]
        counts = []
        for label in sorted(area_labels, key=lambda label: label["name"]):
            nodes = self._gh(["issue", "list", "--state", "open", "--label", label["id"],
                              "--json", "number", "--limit", "1000"])
            counts.append((label["name"], len(nodes or [])))
        return counts

    def flag_for_human(self, issue, agent_key, ask):
        number = issue["id"]
        label = self._ensure_label("needs-maya")
        if not any(node["name"].lower() == label.lower() for node in issue["labels"]["nodes"]):
            self._gh(["issue", "edit", number, "--add-label", label], parse_json=False)
        self.comment(issue["id"], f"🔶 DECISION NEEDED (Agent {agent_key})\n{ask}")
        return True

    def labels(self):
        if self._label_names is None:
            labels = self._gh(["label", "list", "--limit", "1000", "--json", "name"])
            self._label_names = [label["name"] for label in labels or []]
        parsed = []
        for label in self._label_names:
            parent, separator, name = label.partition(": ")
            parsed.append({"id": label, "name": name if separator else label,
                           "parent": {"name": parent} if separator else None})
        return parsed


def _project_for_agent(agent_key, registry_path=None):
    # Accept a str OR Path (or None → default) and coerce, so a string config path fails soft to
    # linear via the guarded read below rather than an uncaught AttributeError (HED-408 review).
    path = pathlib.Path(registry_path) if registry_path else (pathlib.Path.home() / ".heddle" / "projects.json")
    try:
        registry = json.loads(path.read_text())
    except (OSError, ValueError):
        # ValueError covers JSONDecodeError AND UnicodeDecodeError — a corrupt-encoding registry must
        # fail soft to linear, not crash lin.sh (HED-408 adversarial review, ledger 841).
        return None
    if not isinstance(registry, dict):
        return None
    projects = registry.get("projects")
    if not isinstance(projects, list):
        return None
    project = next((candidate for candidate in projects
                    if isinstance(candidate, dict)
                    and isinstance(candidate.get("agentIds"), list)
                    and agent_key in candidate["agentIds"]), None)
    return project


def _tracker_string(project):
    if project is None:
        return "linear"
    tracker = project.get("tracker")
    if not isinstance(tracker, str) or not tracker.strip():
        return "linear"
    tracker = tracker.strip().lower()
    if tracker in ("linear", "github"):
        return tracker
    print(f"lin.sh: warning: unsupported tracker {tracker!r} for project "
          f"{project.get('name', '?')!r}; defaulting to linear",
          file=sys.stderr)
    return "linear"


def tracker_backend_for_agent(agent_key, registry_path=None):
    return _tracker_string(_project_for_agent(agent_key, registry_path))


def tracker_for_agent(agent_key, registry_path=None):
    project = _project_for_agent(agent_key, registry_path)
    backend = _tracker_string(project)
    if backend == "linear":
        return LinearTracker(agent_key)
    if backend == "github":
        repo = (project or {}).get("githubRepo")
        if not isinstance(repo, str) or not repo.strip():
            sys.exit(f"lin.sh: agent {agent_key!r} has tracker=github but no githubRepo — add "
                     f'"githubRepo": "owner/repo" to ~/.heddle/projects.json')
        team = (project or {}).get("linearTeam")
        if not isinstance(team, str) or not team.strip():
            sys.exit(f"lin.sh: agent {agent_key!r} has tracker=github but no linearTeam — add "
                     f'"linearTeam": "HED" to ~/.heddle/projects.json')
        return GitHubIssuesTracker(agent_key, repo.strip(), team.strip())
    raise SystemExit(f"lin.sh: internal error: tracker backend {backend!r} selected but not wired")


def author_of(c):
    for k in ("user", "botActor", "externalUser"):
        if c.get(k) and c[k].get("name"):
            return c[k]["name"]
    return "?"


def short(s, n=88):
    s = (s or "").replace("\n", " ").strip()
    return s if len(s) <= n else s[:n - 1] + "…"


# This guard prevents drift: a heddle agent forgetting scope and mutating an SPI issue, not deliberate
# impersonation. Identity is self-asserted, but each key uses its own OAuth token, so acting as another
# agent requires that agent's credentials and is attributed to them; the honest path refuses per fleet-scope.md §4.
def is_heddle_fleet(key):
    k = str(key or "").strip().upper()
    return len(k) == 1 and k in HEDDLE_FLEET


def scope_refusal(ident, issue, agent_key, action="claim"):
    if not is_heddle_fleet(agent_key):
        return None
    team_key = ((issue.get("team") or {}).get("key") or "").strip().upper()
    if not team_key:
        return (f"{ident}: REFUSED — team key unavailable from Linear; the fleet-scope guard fails closed "
                f"for heddle-fleet identities ({FLEET_SCOPE_RULE}). Retry; if it persists, report to R.")
    if team_key != APP_TEAM_KEY:
        return None
    refusal = (f"{ident}: REFUSED — cannot {action} a Spinventory app issue (team {APP_TEAM_KEY}). {FLEET_SCOPE_RULE} "
               "§1–2 (Maya, firsthand 2026-08-23): the heddle fleet never touches the app and the "
               "SPI board is never consulted; there is no commission path. Work comes from LIN_TEAM=HED "
               "lin.sh list or from R (port issues carry the Spinventory-Port label in HED).")
    delegate = issue.get("delegate") or {}
    if delegate.get("name"):
        refusal += (f" Currently held by {delegate['name']} — that is the Spinventory fleet's business, "
                    "not yours.")
    return refusal


def create_refusal(agent_key, team_key):
    if not is_heddle_fleet(agent_key) or str(team_key or "").strip().upper() != APP_TEAM_KEY:
        return None
    return (f"REFUSED — cannot create an issue in team {APP_TEAM_KEY} from a heddle-fleet identity. "
            f"{FLEET_SCOPE_RULE} §2 (Maya, firsthand 2026-08-23): every issue this fleet files goes "
            "in the HED team — re-run with LIN_TEAM=HED (port issues carry the Spinventory-Port label).")


def read_needs_maya_queue(path=NEEDS_MAYA):
    try:
        entries = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    return [entry for entry in entries if isinstance(entry, dict)] if isinstance(entries, list) else []


def write_needs_maya_queue(path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    temp_path = pathlib.Path(temp_name)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(entries, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, path)
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
    finally:
        if temp_path.exists():
            temp_path.unlink()


def append_needs_maya_entry(entry, path=NEEDS_MAYA):
    import fcntl

    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            entries = read_needs_maya_queue(path)
            for index, existing in enumerate(entries):
                if existing.get("issue") == entry.get("issue"):
                    entries[index] = entry
                    break
            else:
                entries.append(entry)
            write_needs_maya_queue(path, entries)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def queue_timestamp(entry):
    try:
        timestamp = datetime.fromisoformat(entry.get("ts", "").replace("Z", "+00:00"))
        return timestamp if timestamp.tzinfo else timestamp.replace(tzinfo=timezone.utc)
    except (AttributeError, TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)


def queue_age(entry, now):
    seconds = max(0, int((now - queue_timestamp(entry)).total_seconds()))
    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes = seconds // 60
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


# ---------- commands ----------

def cmd_whoami(lin, _args):
    print(f"agent key : {lin.key}")
    identity_id = lin.me["id"]
    suffix = "…" if len(identity_id) > 8 else ""
    print(f"identity  : {lin.me['name']} (id {identity_id[:8]}{suffix})")


def cmd_view(lin, args):
    i = lin.issue(args.issue)
    delegate = i["delegate"]["name"] if i["delegate"] else "—"
    assignee = i["assignee"]["name"] if i["assignee"] else "—"
    labels = ", ".join(l["name"] for l in i["labels"]["nodes"]) or "—"
    print(f"{i['identifier']}  {i['title']}")
    print(f"  state    : {i['state']['name']}   priority: {i['priorityLabel']}")
    print(f"  delegate : {delegate}   assignee: {assignee}")
    print(f"  labels   : {labels}")
    print(f"  branch   : {i['branchName']}   (a PR from this branch auto-links; "
          f"otherwise put 'Fixes {i['identifier']}' in the PR body)")
    print(f"  url      : {i['url']}")
    if i["description"]:
        print("  ---- description ----")
        for line in i["description"].splitlines():
            print(f"  {line}")
    cs = i["comments"]["nodes"]
    if cs:
        print("  ---- recent comments ----")
        for c in cs:
            print(f"  [{c['createdAt'][:10]}] {author_of(c)}: {short(c['body'], 120)}")


def cmd_list(lin, args):
    if is_heddle_fleet(lin.key) and TEAM_KEY.strip().upper() != "HED":
        print(f"⛔ {FLEET_SCOPE_RULE} (Maya, firsthand 2026-08-23): the heddle fleet works the HED "
              f"board only — {TEAM_KEY}-team issues are not a source of work; use LIN_TEAM=HED lin.sh "
              f"list. Claims on {APP_TEAM_KEY}-team issues are refused for heddle-fleet identities.",
              file=sys.stderr)
    # me_id only matters to the `mine` filter; resolving lin.me for an unclaimed list would add a
    # viewer round-trip origin/main never made (and a new failure mode) — HED-408 phase-2a review.
    rows = lin.list_issues(mine=args.mine, area=args.area,
                           me_id=(lin.me["id"] if args.mine else None), limit=args.limit)
    if not rows:
        print("no matching issues")
        return
    for row in rows:
        who = f"  ← {row['delegate_name']}" if row["delegate_name"] else ""
        print(f"{row['identifier']:<8} {row['priorityLabel']:<9} [{row['area']}] "
              f"{short(row['title'], 70)} ({row['state_name']}){who}")


def cmd_areas(lin, args):
    for name, n in lin.area_counts():
        print(f"{name:<22} {n} open")


def cmd_claim(lin, args):
    rc = 0
    for ident in args.issues:
        i = lin.issue(ident)
        issue_team = ((i.get("team") or {}).get("key")) or None
        refusal = scope_refusal(ident, i, lin.key)
        if refusal:
            print(refusal)
            rc = 2
            continue
        d = i["delegate"]
        if d and d["id"] != lin.me["id"]:
            print(f"{ident}: STAND DOWN — already claimed by {d['name']} "
                  f"(state {i['state']['name']}). Coordinate with them or Maya; "
                  f"do not work this issue.")
            rc = 2
            continue
        fields = {"delegateId": lin.me["id"]}
        if i["state"]["type"] in ("backlog", "unstarted"):
            fields["stateId"] = lin.state_by(type="started", name="In Progress",
                                              team_key=issue_team)["id"]
        lin.update(i["id"], **fields)
        if not (d and d["id"] == lin.me["id"]):
            lin.comment(i["id"], f"Claimed by **{lin.me['name']}** — starting work.")
        print(f"{ident}: claimed as {lin.me['name']} (state → In Progress)")
    sys.exit(rc)


def cmd_unclaim(lin, args):
    i = lin.issue(args.issue)
    issue_team = ((i.get("team") or {}).get("key")) or None
    d = i["delegate"]
    if d and d["id"] != lin.me["id"]:
        sys.exit(f"lin.sh: {args.issue} is claimed by {d['name']}, not you — not touching it.")
    reason = " ".join(args.reason) or "releasing this issue for anyone to pick up."
    lin.update(i["id"], delegateId=None,
               stateId=lin.state_by(type="unstarted", name="Todo", team_key=issue_team)["id"])
    lin.comment(i["id"], f"Released by **{lin.me['name']}** — {reason}")
    print(f"{args.issue}: released (state → Todo)")


def cmd_mine(lin, args):
    args.mine, args.area, args.limit = True, None, 50
    cmd_list(lin, args)


def cmd_comment(lin, args):
    i = lin.issue(args.issue)
    lin.comment(i["id"], " ".join(args.text))
    print(f"{args.issue}: commented as {lin.me['name']}")


def cmd_resolve(lin, args):
    i = lin.issue(args.issue)
    refusal = scope_refusal(args.issue, i, lin.key, "resolve")
    if refusal:
        print(refusal)
        sys.exit(2)
    lin.comment(i["id"], f"**Resolution** ({lin.me['name']}): " + " ".join(args.text))
    print(f"{args.issue}: resolution posted (state unchanged — PR merge moves it to Done)")


def cmd_done(lin, args):
    i = lin.issue(args.issue)
    issue_team = ((i.get("team") or {}).get("key")) or None
    refusal = scope_refusal(args.issue, i, lin.key, "done")
    if refusal:
        print(refusal)
        sys.exit(2)
    lin.comment(i["id"], f"**Resolution** ({lin.me['name']}): " + " ".join(args.text))
    lin.update(i["id"], stateId=lin.state_by(type="completed", name="Done", team_key=issue_team)["id"])
    print(f"{args.issue}: resolved + moved to Done")


def cmd_create(lin, args):
    refusal = create_refusal(lin.key, TEAM_KEY)
    if refusal:
        print(refusal)
        sys.exit(2)
    res = lin.create_issue(title=args.title, type_label=args.type, area=args.area,
                           platform=args.platform, desc=args.desc, priority=args.priority)
    print(f"created {res['identifier']}  {res['url']}")


def cmd_needs_maya(lin, args):
    if args.issue_or_list.lower() == "list":
        if args.ask:
            sys.exit("lin.sh: needs-maya list does not take an ask")
        entries = read_needs_maya_queue()
        if not entries:
            print("no pending Maya decisions")
            return
        now = datetime.now(timezone.utc)
        for entry in sorted(entries, key=queue_timestamp):
            print(f"{entry.get('issue', '?'):<10} {entry.get('agent', '?'):<10} "
                  f"{queue_age(entry, now):>7}  {entry.get('ask_preview', '')}")
        return

    if not args.ask:
        sys.exit("lin.sh: needs-maya requires <ISSUE-ID> and <ask>")

    issue = lin.issue(args.issue_or_list)
    refusal = scope_refusal(args.issue_or_list, issue, lin.key, "flag for Maya")
    if refusal:
        print(refusal)
        sys.exit(2)
    if not lin.flag_for_human(issue, lin.key, args.ask):
        sys.exit("lin.sh: could not post the needs-maya decision comment; queue entry was not added")
    append_needs_maya_entry({
        "issue": issue["identifier"],
        "agent": lin.key,
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "ask_preview": short(args.ask, 100),
    })
    print(issue["url"])


def main():
    p = argparse.ArgumentParser(prog="lin.sh", add_help=True,
                                description="Spinventory fleet Linear CLI")
    p.add_argument("--agent", help="fleet key (A..P letters, 1..6 claudex, codex-A..codex-E); "
                                   "else $FLEET_AGENT, else .fleet-agent file")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("whoami")
    v = sub.add_parser("view"); v.add_argument("issue")
    ls = sub.add_parser("list")
    ls.add_argument("--area"); ls.add_argument("--mine", action="store_true")
    ls.add_argument("--limit", type=int, default=25)
    sub.add_parser("areas")
    c = sub.add_parser("claim"); c.add_argument("issues", nargs="+")
    u = sub.add_parser("unclaim"); u.add_argument("issue"); u.add_argument("reason", nargs="*")
    sub.add_parser("mine")
    cm = sub.add_parser("comment"); cm.add_argument("issue"); cm.add_argument("text", nargs="+")
    r = sub.add_parser("resolve"); r.add_argument("issue"); r.add_argument("text", nargs="+")
    dn = sub.add_parser("done"); dn.add_argument("issue"); dn.add_argument("text", nargs="+")
    cr = sub.add_parser("create")
    cr.add_argument("title"); cr.add_argument("--desc")
    cr.add_argument("--type", default="Bug"); cr.add_argument("--area")
    cr.add_argument("--platform"); cr.add_argument("--priority", type=int, choices=[1, 2, 3, 4])
    nm = sub.add_parser("needs-maya", help="label an issue and ask Maya for a decision")
    nm.add_argument("issue_or_list", metavar="ISSUE-ID|list")
    nm.add_argument("ask", nargs="?", help="QUESTION (1 sentence) / OPTIONS (a) b) ..., mark REC) / CONTEXT (PR/file links)")
    args = p.parse_args()

    if args.cmd == "needs-maya" and args.issue_or_list.lower() == "list":
        cmd_needs_maya(None, args)
        return

    lin = tracker_for_agent(resolve_agent(args.agent))
    {"whoami": cmd_whoami, "view": cmd_view, "list": cmd_list, "areas": cmd_areas,
     "claim": cmd_claim, "unclaim": cmd_unclaim, "mine": cmd_mine,
     "comment": cmd_comment, "resolve": cmd_resolve, "done": cmd_done,
     "create": cmd_create, "needs-maya": cmd_needs_maya}[args.cmd](lin, args)


if __name__ == "__main__":
    main()
