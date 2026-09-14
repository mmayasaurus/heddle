#!/usr/bin/env python3
"""pr-linear-sync.sh — mirror the app repo's GitHub PRs into Linear team "PR".

Gives Maya a separate, visual "Pull Requests" list in Linear (team key PR),
independent of the SPI bug/feature issues but auto-cross-linked to them when a
PR references SPI-n (body, title, or branch name).

State mapping (stock team states — no surgery):
    draft PR            -> In Progress
    open  PR            -> In Review
    merged              -> Done
    closed (unmerged)   -> Canceled

Re-runnable sync, safe at any cadence:
  * first sight of an OPEN pr  -> creates PR-<n> issue (title "#1234 - <title>"),
    attaches the live GitHub PR card, relates any SPI-n it mentions, and sets
    the issue's DELEGATE to the claiming fleet agent when derivable from the
    PR's title tag ("[Agent X]" / "[Codex X]"), owner label (owner:agent-x /
    owner:codex-x), or an agent-lettered branch name
  * tracked PR changes state   -> moves the Linear issue accordingly
  * tracked PR without a recorded delegate -> retries the derivation (so adding
    an owner label later still gets picked up on the next run)
  * merged/closed PRs never seen while open are NOT backfilled
State: ~/.claude/spinventory-fleet/pr-sync-state.json. Runs as Agent A's token
with createAsUser "PR Sync" so the list is visibly machine-maintained.

Run it directly (any instance, Maya, or a future cron): .claude/bin/pr-linear-sync.sh
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FLEET = pathlib.Path(os.path.expanduser("~/.claude/spinventory-fleet"))
# State is per-repo: the default Spinventory repo keeps the legacy filename; other repos get
# pr-sync-state.<repo-basename>.json so their PR-<n> tracking never collides.
def _state_path():
    d = os.environ.get("SYNC_REPO_DIR", "").strip()
    if not d:
        return FLEET / "pr-sync-state.json"
    return FLEET / f"pr-sync-state.{pathlib.Path(d).name}.json"
STATE_PATH = _state_path()
TOKEN_KEY = "A"  # acts via Agent A's app token; display attribution is "PR Sync"
# Repo to sync. Default = the Spinventory app repo; the heddle repos pass their own path via
# SYNC_REPO_DIR (added 2026-08-15 for the HED team). Each repo keeps its own state namespace.
INNER_REPO = os.environ.get("SYNC_REPO_DIR", "").strip() or (
    "/Users/mayatobi/Developer/Spinventory-Rebuild-App/"
    "Spinventory-Rebuild-Official/Rebuild-Project-Root")
PR_TEAM_KEY = "PR"
BODY_LIMIT = 2500
# Any fleet team's issue key relates: SPI (Spinventory) and HED (heddle, team created 2026-08-15).
SPI_RE = re.compile(r"\b(SPI|HED)-(\d+)\b", re.IGNORECASE)
# Single letters only; unknown letters resolve to no actor via linear-agents.json,
# so growing the fleet (M was minted after A-L) never needs a regex change again.
TITLE_TAG_RE = re.compile(r"\[(Agent|Codex)\s+([A-Z])\]", re.IGNORECASE)
OWNER_LABEL_RE = re.compile(r"^owner:(agent|codex)-([a-z])$", re.IGNORECASE)
BRANCH_AGENT_RE = re.compile(r"\bagent[-_]([a-z])(?![a-z0-9])", re.IGNORECASE)


def derive_agent(pr):
    """Fleet key ("A".."L" or "codex-A".."codex-E") from the PR's claim signals,
    or None. Precedence: title tag > owner label > agent-lettered branch."""
    m = TITLE_TAG_RE.search(pr["title"])
    if m:
        kind, letter = m.group(1).lower(), m.group(2).upper()
        return f"codex-{letter}" if kind == "codex" else letter
    for l in pr.get("labels") or []:
        m = OWNER_LABEL_RE.match(l.get("name", ""))
        if m:
            kind, letter = m.group(1).lower(), m.group(2).upper()
            return f"codex-{letter}" if kind == "codex" else letter
    m = BRANCH_AGENT_RE.search(pr["headRefName"])
    if m:
        return m.group(1).upper()
    return None


def actor_id(state, key):
    """Linear user id for a fleet agent, resolved once via that agent's own
    token and cached in the state file. None if the key has no local creds."""
    ids = state.setdefault("actor_ids", {})
    if key in ids:
        return ids[key]
    try:
        creds = json.load(open(FLEET / "linear-agents.json"))["agents"]
        if key not in creds:
            return None
        a = creds[key]
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials", "client_id": a["client_id"],
            "client_secret": a["client_secret"],
            "scope": "read,write,issues:create,comments:create,app:assignable,app:mentionable",
        }).encode()
        req = urllib.request.Request("https://api.linear.app/oauth/token", data=body,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        tok = json.load(urllib.request.urlopen(req))
        cache = FLEET / f"token-{key}.json"
        cache.write_text(json.dumps(tok))
        os.chmod(cache, 0o600)
        q = json.dumps({"query": "{ viewer { id } }"}).encode()
        r = urllib.request.Request("https://api.linear.app/graphql", data=q, headers={
            "Authorization": f"Bearer {tok['access_token']}",
            "Content-Type": "application/json"})
        ids[key] = json.load(urllib.request.urlopen(r))["data"]["viewer"]["id"]
        return ids[key]
    except Exception:
        return None


def token():
    cache = FLEET / f"token-{TOKEN_KEY}.json"
    tok = json.load(open(cache))
    if (time.time() - cache.stat().st_mtime) > tok.get("expires_in", 0) - 86400:
        creds = json.load(open(FLEET / "linear-agents.json"))["agents"][TOKEN_KEY]
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials", "client_id": creds["client_id"],
            "client_secret": creds["client_secret"],
            "scope": "read,write,issues:create,comments:create,app:assignable,app:mentionable",
        }).encode()
        req = urllib.request.Request("https://api.linear.app/oauth/token", data=body,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        tok = json.load(urllib.request.urlopen(req))
        cache.write_text(json.dumps(tok))
        os.chmod(cache, 0o600)
    return tok["access_token"]


TOK = None


def gql(query, variables=None, retries=3):
    global TOK
    if TOK is None:
        TOK = token()
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request("https://api.linear.app/graphql", data=body, headers={
                "Authorization": f"Bearer {TOK}", "Content-Type": "application/json"})
            out = json.load(urllib.request.urlopen(req))
            if out.get("errors"):
                raise RuntimeError("; ".join(e.get("message", "?") for e in out["errors"]))
            return out["data"]
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = "; ".join(err.get("message", "?") for err in json.load(e).get("errors", []))
            except Exception:
                pass
            if e.code == 400 or attempt == retries - 1:
                sys.exit(f"pr-linear-sync: Linear API error {e.code}: {detail or e.reason}")
            time.sleep(2)
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2)


def gh_prs():
    out = subprocess.run(
        ["gh", "pr", "list", "--state", "all", "--limit", "100", "--json",
         "number,title,url,body,author,headRefName,isDraft,state,updatedAt,labels"],
        capture_output=True, text=True, cwd=INNER_REPO, timeout=60)
    if out.returncode != 0:
        sys.exit(f"pr-linear-sync: gh pr list failed: {out.stderr.strip()}")
    return json.loads(out.stdout)


def pr_state_name(pr):
    if pr["state"] == "MERGED":
        return "Done"
    if pr["state"] == "CLOSED":
        return "Canceled"
    return "In Progress" if pr["isDraft"] else "In Review"


def main():
    states = gql('{ workflowStates(filter:{team:{key:{eq:"%s"}}}) '
                 '{ nodes { id name } } }' % PR_TEAM_KEY)["workflowStates"]["nodes"]
    state_id = {s["name"]: s["id"] for s in states}
    team_id = gql('{ teams(filter:{key:{eq:"%s"}}) { nodes { id } } }'
                  % PR_TEAM_KEY)["teams"]["nodes"][0]["id"]

    state = {"prs": {}}
    if STATE_PATH.exists():
        state = json.load(open(STATE_PATH))

    def save():
        tmp = str(STATE_PATH) + ".tmp"
        json.dump(state, open(tmp, "w"), indent=2)
        os.replace(tmp, STATE_PATH)
        os.chmod(STATE_PATH, 0o600)

    created = moved = 0
    fetched_prs = gh_prs()
    for pr in sorted(fetched_prs, key=lambda p: p["number"]):
        n = str(pr["number"])
        want = pr_state_name(pr)
        tracked = state["prs"].get(n)

        if tracked:
            if tracked.get("last_state") != want:
                gql("""mutation($id: String!, $input: IssueUpdateInput!) {
                    issueUpdate(id: $id, input: $input) { success } }""",
                    {"id": tracked["issue_id"], "input": {"stateId": state_id[want]}})
                print(f"  {tracked['identifier']}  #{n} state: {tracked['last_state']} -> {want}")
                tracked["last_state"] = want
                moved += 1
                save()
            if not tracked.get("delegate") and pr["state"] == "OPEN":
                key = derive_agent(pr)
                aid = actor_id(state, key) if key else None
                if aid:
                    gql("""mutation($id: String!, $input: IssueUpdateInput!) {
                        issueUpdate(id: $id, input: $input) { success } }""",
                        {"id": tracked["issue_id"], "input": {"delegateId": aid}})
                    tracked["delegate"] = key
                    print(f"  {tracked['identifier']}  #{n} delegate -> {key}")
                    save()
            continue

        if pr["state"] != "OPEN":
            continue  # never backfill PRs that were already merged/closed

        author = (pr.get("author") or {}).get("login", "?")
        body = (pr.get("body") or "").strip()
        if len(body) > BODY_LIMIT:
            body = body[:BODY_LIMIT] + "\n\n*(truncated)*"
        desc = (f"**GitHub PR:** {pr['url']}\n"
                f"**Author:** {author} · **Branch:** `{pr['headRefName']}`\n\n"
                f"---\n{body}\n\n---\n*Synced by pr-linear-sync; state follows the "
                f"PR (draft→In Progress, open→In Review, merged→Done, closed→Canceled).*")
        key = derive_agent(pr)
        aid = actor_id(state, key) if key else None
        # Non-default repos get a "<repo> " prefix so heddle #12 and spinventory #12 stay distinct.
        _repo_tag = ("" if not os.environ.get("SYNC_REPO_DIR", "").strip()
                     else pathlib.Path(INNER_REPO).name + " ")
        inp = {"teamId": team_id, "title": f"{_repo_tag}#{n} — {pr['title']}",
               "description": desc, "stateId": state_id[want],
               "createAsUser": "PR Sync"}
        if aid:
            inp["delegateId"] = aid
        d = gql("""mutation($input: IssueCreateInput!) {
            issueCreate(input: $input) { issue { id identifier } } }""",
            {"input": inp})
        iss = d["issueCreate"]["issue"]
        gql("""mutation($issueId: String!, $url: String!) {
            attachmentLinkGitHubPR(issueId: $issueId, url: $url) { success } }""",
            {"issueId": iss["id"], "url": pr["url"]})

        linked = []
        mentions = set((pfx.upper(), num) for pfx, num in SPI_RE.findall(" ".join(
            [pr["title"], pr.get("body") or "", pr["headRefName"]])))
        for pfx, num in sorted(mentions, key=lambda t: (t[0], int(t[1]))):
            ident = f"{pfx}-{num}"
            try:
                spi = gql('query($i: String!) { issue(id: $i) { id } }', {"i": ident})["issue"]
            except SystemExit:
                raise
            except Exception:
                spi = None
            if not spi:
                continue  # SPI issue deleted/nonexistent — skip quietly
            try:
                gql("""mutation($input: IssueRelationCreateInput!) {
                    issueRelationCreate(input: $input) { success } }""",
                    {"input": {"issueId": iss["id"], "relatedIssueId": spi["id"],
                               "type": "related"}})
            except SystemExit:
                raise
            except Exception:
                # A trashed SPI issue still resolves in the lookup above but
                # rejects relations ("Entity is trashed: issue") — one bad
                # mention must not kill the whole sync run. Skip quietly.
                continue
            linked.append(ident)

        state["prs"][n] = {"issue_id": iss["id"], "identifier": iss["identifier"],
                           "last_state": want, "delegate": key if aid else None}
        save()
        created += 1
        rel = f"  ⇄ {', '.join(linked)}" if linked else ""
        who = f"  → {key}" if aid else ""
        print(f"  {iss['identifier']}  #{n} [{want}] {pr['title'][:60]}{rel}{who}")
        time.sleep(0.3)

    # Straggler pass (SPI-237): a tracked PR older than the fetch window
    # (`gh pr list --limit 100`, newest-first) never appears in the loop
    # above, so its merge/close would never sync — the PR-issue sat in
    # "In Review" forever. Fetch those individually; only non-terminal ones
    # (Done/Canceled never move again), so this stays a handful of calls.
    fetched_nums = {str(p["number"]) for p in fetched_prs}
    stragglers = moved_stragglers = 0
    for n, tracked in sorted(state["prs"].items(), key=lambda kv: int(kv[0])):
        if n in fetched_nums or tracked.get("last_state") in ("Done", "Canceled"):
            continue
        stragglers += 1
        out = subprocess.run(
            ["gh", "pr", "view", n, "--json", "state,isDraft"],
            capture_output=True, text=True, cwd=INNER_REPO, timeout=60)
        if out.returncode != 0:
            print(f"  {tracked['identifier']}  #{n} straggler fetch failed: "
                  f"{out.stderr.strip()[:100]}")
            continue
        pr = json.loads(out.stdout)
        want = pr_state_name(pr)
        if tracked.get("last_state") != want:
            gql("""mutation($id: String!, $input: IssueUpdateInput!) {
                issueUpdate(id: $id, input: $input) { success } }""",
                {"id": tracked["issue_id"], "input": {"stateId": state_id[want]}})
            print(f"  {tracked['identifier']}  #{n} state: {tracked['last_state']} -> {want} (straggler)")
            tracked["last_state"] = want
            moved += 1
            moved_stragglers += 1
            save()
        time.sleep(0.2)
    if stragglers:
        print(f"  straggler pass: {stragglers} tracked PR(s) outside the fetch window, "
              f"{moved_stragglers} moved")

    print(f"\nsync done: created={created} state_moves={moved} tracked={len(state['prs'])}")


if __name__ == "__main__":
    main()
