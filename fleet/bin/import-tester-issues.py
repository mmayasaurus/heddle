#!/usr/bin/env python3
"""Import tester bug-report sheet rows into Linear (team SPI).

Self-contained + re-runnable. Fetches the tester bug-report Google Sheet as CSV
(link-shared; no auth), then creates Linear issues (team SPI) for rows that are
NOT already imported — skipping rows whose FIXED? column is non-empty and
genuinely-blank sheet rows. Each imported row is recorded by a stable row-hash in
~/.claude/spinventory-fleet/tester-import-state.json, so re-runs (and the launchd
poller) only ever create issues for NEW rows. State writes are incremental so a
crash mid-run never double-creates.

Every issue gets the same tags the seeding run used:
  Bug + Tester Report (always) · Platform (Android/iOS -> Mobile, Web -> Web) ·
  Area (from "Where did it happen?" when it matches an Area label) · Priority
  (Critical->Urgent, High->2, Medium->3, Low/Cosmetic->4). Author shows as the
  "Tester Import" app-user so the board attributes them consistently.

After creating, flags likely-duplicate pairs among tester-imported issues with the
"Possible Duplicate" label + a cross-linking comment (conservative title-similarity
threshold; Maya verifies/merges in Linear).

Usage:
  import-tester-issues.py             # fetch live sheet, create issues for new rows
  import-tester-issues.py --dry-run   # show what WOULD be created; creates nothing
  import-tester-issues.py --csv PATH  # read a local CSV instead of fetching the sheet
"""
import argparse, csv, hashlib, io, json, os, re, sys, time, urllib.parse, urllib.request

FLEET = os.path.expanduser("~/.claude/spinventory-fleet")
STATE_PATH = os.path.join(FLEET, "tester-import-state.json")

# The tester bug-report sheet (link-shared). CSV export needs the doc id + the
# tab's gid; the /edit URL is what we link back to from each issue.
SHEET_DOC_ID = "1UIvV0Bsd97i1pgY-hxOIjncPhS0LketnP3cO0KNNlwc"
SHEET_GID = "1430083001"
SHEET_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_DOC_ID}/edit"
CSV_EXPORT_URL = (f"https://docs.google.com/spreadsheets/d/{SHEET_DOC_ID}"
                  f"/export?format=csv&gid={SHEET_GID}")

TEAM_ID = "0618d1a0-4076-4367-a07b-f69c296b0582"
TODO_STATE_ID = "1ef98fde-a943-4bf2-8c58-ed30dd7c37c6"
PRIORITY = {"Critical": 1, "High": 2, "Medium": 3, "Low": 4, "Cosmetic": 4}
PLATFORM_LABEL = {"Android": "Mobile", "iOS": "Mobile", "Web": "Web"}

# Tester imports always act as Agent A (matches the seeding run's author/attribution).
AGENT_KEY = "A"
CREDS_PATH = os.path.join(FLEET, "linear-agents.json")
SCOPE = "read,write,issues:create,comments:create,app:assignable,app:mentionable"

_TOKEN = None
def token():
    """Return a valid Linear access token for Agent A, re-minting on expiry so the
    unattended poller stays alive past the 30-day token cache. Mirrors lin.sh's
    get_token exactly (client_credentials grant from linear-agents.json); memoized
    per run. Falls back to any cached token if a re-mint attempt fails."""
    global _TOKEN
    if _TOKEN is not None:
        return _TOKEN
    cache = os.path.join(FLEET, f"token-{AGENT_KEY}.json")
    cached = None
    if os.path.exists(cache):
        cached = json.load(open(cache))
        age = time.time() - os.stat(cache).st_mtime
        if age < cached.get("expires_in", 0) - 86400:  # not within a day of expiry
            _TOKEN = cached["access_token"]
            return _TOKEN
    try:
        creds = json.load(open(CREDS_PATH))["agents"][AGENT_KEY]
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials", "client_id": creds["client_id"],
            "client_secret": creds["client_secret"], "scope": SCOPE}).encode()
        req = urllib.request.Request("https://api.linear.app/oauth/token", data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"})
        tok = json.load(urllib.request.urlopen(req))
        with open(cache, "w") as f:
            json.dump(tok, f)
        os.chmod(cache, 0o600)
        _TOKEN = tok["access_token"]
    except Exception:
        if not cached:
            raise
        _TOKEN = cached["access_token"]  # expired-ish but better than nothing
    return _TOKEN

def gql(query, variables=None, retries=3):
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                "https://api.linear.app/graphql", data=body,
                headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
            out = json.load(urllib.request.urlopen(req))
            if out.get("errors"):
                raise RuntimeError(out["errors"])
            return out["data"]
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(3)

def fetch_csv():
    """Return the sheet as CSV text, following Google's export redirects."""
    req = urllib.request.Request(CSV_EXPORT_URL, headers={"User-Agent": "Mozilla/5.0"})
    data = urllib.request.urlopen(req, timeout=45).read().decode("utf-8", "replace")
    head = data.lstrip()[:200].lower()
    if head.startswith("<!doctype html") or "<html" in head:
        sys.exit("FATAL: sheet export returned HTML (not link-shared / needs auth?) — aborting.")
    return data

def read_rows(csv_path=None):
    text = open(csv_path, encoding="utf-8").read() if csv_path else fetch_csv()
    return list(csv.DictReader(io.StringIO(text)))

def row_key(r):
    # Stable identity — MUST match the seeding run so the existing state file's
    # 30 rows keep de-duping. Do not change the fields or order.
    basis = "|".join([r.get("Timestamp", ""), r.get("Your name or Tester ID", ""),
                      r.get("What was the error/bug?", "")]).strip()
    return hashlib.sha1(basis.encode()).hexdigest()[:16]

def is_blank_row(r):
    """A genuinely-empty sheet row (e.g. a spacer). Skip it so it never becomes an
    'Untitled tester report' issue. Only true when the row carries NO timestamp,
    NO reporter, NO error title, and NO 'what happened' text — so a row that only
    filled in a free-text field still imports (title falls back to that text)."""
    return not any((r.get("Timestamp", "").strip(),
                    r.get("Your name or Tester ID", "").strip(),
                    r.get("What was the error/bug?", "").strip(),
                    r.get("What happened?", "").strip()))

def load_state():
    if os.path.exists(STATE_PATH):
        return json.load(open(STATE_PATH))
    return {"imported": {}}

def save_state(state):
    tmp = STATE_PATH + ".tmp"
    json.dump(state, open(tmp, "w"), indent=2)
    os.replace(tmp, STATE_PATH)
    os.chmod(STATE_PATH, 0o600)

def get_label_ids():
    data = gql('{ issueLabels(first: 250) { nodes { id name parent { name } } } }')
    return {n["name"]: n["id"] for n in data["issueLabels"]["nodes"]}

def sec(title, body):
    body = (body or "").strip()
    return f"## {title}\n{body}\n\n" if body else ""

def issue_title(r):
    return (r.get("What was the error/bug?", "").strip()
            or (r.get("What happened?", "").strip().splitlines() or ["Untitled tester report"])[0])

def build_description(r):
    who = r.get("Your name or Tester ID", "").strip() or "(not given)"
    handle = r.get("Spinventory account handle or email", "").strip()
    contact = r.get("Contact email", "").strip()
    plat = r.get("Platform", "").strip()
    device = r.get("Device model", "").strip()
    osv = r.get("OS / browser version", "").strip()
    build = r.get("App version or build number", "").strip()
    tier = r.get("Which app version/tier were you testing?", "").strip()
    switch = r.get("Did this happen after switching between basic and premium?", "").strip()
    freq = r.get("How often does it happen?", "").strip()
    sev = r.get("How serious would you rate this issue?", "").strip()
    ts = r.get("Timestamp", "").strip()
    shot = r.get("Screenshot or screen recording link", "").strip()

    hdr = [f"**Reported by:** {who}" + (f" ({handle})" if handle else "") + (f" · {contact}" if contact else "")]
    envbits = [b for b in [plat, device, osv, (f"build {build}" if build else "")] if b]
    if envbits: hdr.append("**Environment:** " + " — ".join(envbits))
    tierbits = [b for b in [tier, (f"after basic/premium switch: {switch}" if switch else "")] if b]
    if tierbits: hdr.append("**Tier:** " + " · ".join(tierbits))
    if freq: hdr.append(f"**Frequency:** {freq}")
    if sev: hdr.append(f"**Severity (as reported):** {sev}")
    if ts: hdr.append(f"**Reported:** {ts}")

    d = "\n".join(hdr) + "\n\n"
    d += sec("What happened", r.get("What happened?"))
    d += sec("Expected", r.get("What did you expect to happen?"))
    d += sec("Steps to reproduce", r.get("Steps to reproduce"))
    d += sec("Additional details", r.get("Bug details (please include enough detail for us to reproduce the issue)"))
    d += sec("Anything else", r.get("Anything else?"))
    if shot:
        d += f"**Screenshot / recording:** {shot}\n\n"
    d += f"---\n*Imported from the [tester bug-report sheet]({SHEET_URL}).*"
    return d

STOP = {"the","a","an","in","on","when","i","it","is","to","of","and","or","my",
        "for","with","at","not","doesnt","dont","does","do","cant","can"}
def title_tokens(t):
    return {w for w in re.findall(r"[a-z0-9]+", t.lower()) if w not in STOP and len(w) > 2}

def jaccard(a, b):
    if not a or not b: return 0.0
    return len(a & b) / len(a | b)

def label_ids_for(r, labels):
    ids = [labels["Bug"], labels["Tester Report"]]
    pl = PLATFORM_LABEL.get(r.get("Platform", "").strip())
    if pl: ids.append(labels[pl])
    area = r.get("Where did it happen?", "").strip()
    if area in labels: ids.append(labels[area])
    return ids

def main():
    ap = argparse.ArgumentParser(description="Import tester bug-report sheet rows into Linear (team SPI).")
    ap.add_argument("--dry-run", action="store_true", help="show what would be created; create nothing")
    ap.add_argument("--csv", metavar="PATH", help="read a local CSV instead of fetching the live sheet")
    args = ap.parse_args()

    state = load_state()
    labels = get_label_ids()
    for need in ["Bug", "Tester Report", "Possible Duplicate", "Mobile", "Web"]:
        if need not in labels:
            sys.exit(f"FATAL: label {need!r} not found in workspace")

    rows = read_rows(args.csv)
    created, skipped_done, skipped_seen, skipped_blank = [], 0, 0, 0
    id_by_name = {v: k for k, v in labels.items()}

    for r in rows:
        if r.get("FIXED?", "").strip():
            skipped_done += 1
            continue
        if is_blank_row(r):
            skipped_blank += 1
            continue
        k = row_key(r)
        if k in state["imported"]:
            skipped_seen += 1
            continue
        title = issue_title(r)
        if len(title) > 255: title = title[:252] + "..."
        label_ids = label_ids_for(r, labels)
        area = r.get("Where did it happen?", "").strip()
        prio = PRIORITY.get(r.get("How serious would you rate this issue?", "").strip(), 0)

        if args.dry_run:
            tag_names = [id_by_name[i] for i in label_ids]
            print(f"  WOULD CREATE  [{area or '-'}]  prio={prio}  {title[:66]}")
            print(f"                tags: {', '.join(tag_names)}")
            created.append({"identifier": "(dry-run)", "area": area})
            continue

        inp = {
            "teamId": TEAM_ID, "title": title, "description": build_description(r),
            "stateId": TODO_STATE_ID, "priority": prio,
            "labelIds": label_ids, "createAsUser": "Tester Import",
        }
        data = gql("""mutation($input: IssueCreateInput!) {
            issueCreate(input: $input) { success issue { id identifier title url } } }""",
            {"input": inp})
        iss = data["issueCreate"]["issue"]
        state["imported"][k] = {"id": iss["id"], "identifier": iss["identifier"],
                                "title": title, "area": area, "ts": r.get("Timestamp", "")}
        save_state(state)  # incremental — crash-safe
        created.append(iss | {"area": area})
        print(f"  {iss['identifier']}  [{area or '-'}]  {title[:70]}")
        time.sleep(0.4)

    verb = "would create" if args.dry_run else "created"
    print(f"\n{verb}={len(created)} skipped_fixed={skipped_done} "
          f"already_imported={skipped_seen} skipped_blank={skipped_blank}")

    if args.dry_run:
        return

    # ---- duplicate flagging across ALL tester-imported issues (state file) ----
    entries = list(state["imported"].values())
    flagged = state.setdefault("dupe_flagged", [])
    clusters = []
    for i in range(len(entries)):
        for j in range(i + 1, len(entries)):
            a, b = entries[i], entries[j]
            s = jaccard(title_tokens(a["title"]), title_tokens(b["title"]))
            if s >= 0.55:
                clusters.append((s, a, b))
    dup_label = labels["Possible Duplicate"]
    for s, a, b in sorted(clusters, reverse=True, key=lambda x: x[0]):
        pair = sorted([a["identifier"], b["identifier"]])
        if pair in flagged: continue
        for one, other in [(a, b), (b, a)]:
            gql("""mutation($id: String!, $lid: String!) {
                issueAddLabel(id: $id, labelId: $lid) { success } }""",
                {"id": one["id"], "lid": dup_label})
            gql("""mutation($input: CommentCreateInput!) {
                commentCreate(input: $input) { success } }""",
                {"input": {"issueId": one["id"], "createAsUser": "Tester Import",
                           "body": f"Possible duplicate of **{other['identifier']}** — \"{other['title'][:100]}\" (title similarity {s:.0%}). Flagged automatically during tester-sheet import; please verify and merge/cancel one."}})
        flagged.append(pair)
        save_state(state)
        print(f"  DUPE? {pair[0]} <-> {pair[1]} (sim {s:.0%})")
    if not clusters:
        print("no likely duplicates flagged")

if __name__ == "__main__":
    main()
