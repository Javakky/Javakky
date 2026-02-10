import argparse, os, sys, time, json, tempfile, subprocess
from datetime import datetime, timedelta, timezone, date
from pathlib import Path

import requests
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

GITHUB_API = "https://api.github.com"
GITHUB_GQL = "https://api.github.com/graphql"

# -----------------------------
# GitHub API helpers
# -----------------------------
def gh_headers(token: str):
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pr-lang-pie-linguist-alltime",
    }

def gql(token: str, query: str, variables: dict):
    """
    GitHub GraphQL は「部分的に FORBIDDEN」でも data を返しつつ errors を併記することがある。
    今回は「片方が死んでも片方は進める」ため、data があれば返す（errors は別で返す）。
    """
    r = requests.post(
        GITHUB_GQL,
        headers=gh_headers(token),
        json={"query": query, "variables": variables},
        timeout=60,
    )
    r.raise_for_status()
    j = r.json()
    data = j.get("data")
    errors = j.get("errors") or []
    if data is None:
        raise RuntimeError(errors or "GraphQL returned no data")
    return data, errors

def rest_get(token: str, path: str, params=None):
    r = requests.get(f"{GITHUB_API}{path}", headers=gh_headers(token), params=params, timeout=60)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()

# -----------------------------
# GraphQL queries
# -----------------------------
USER_CREATED = """
query($login: String!) {
  user(login: $login) { createdAt }
}
"""

PR_SEARCH = """
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        mergedAt
        repository { nameWithOwner }
      }
    }
  }
}
"""

def get_user_created_at(token: str, login: str) -> datetime:
    data, errs = gql(token, USER_CREATED, {"login": login})
    if errs:
        # user取得でerrorsは致命的（login間違い等）
        raise RuntimeError(errs)
    s = data["user"]["createdAt"]
    return datetime.fromisoformat(s.replace("Z", "+00:00"))

# -----------------------------
# Windowing (month)
# -----------------------------
def month_start(d: date) -> date:
    return date(d.year, d.month, 1)

def add_month(d: date) -> date:
    if d.month == 12:
        return date(d.year + 1, 1, 1)
    return date(d.year, d.month + 1, 1)

def iter_month_windows(start: date, end_exclusive: date):
    cur = month_start(start)
    while cur < end_exclusive:
        nxt = add_month(cur)
        yield cur, min(nxt, end_exclusive)
        cur = nxt

# -----------------------------
# PR listing (windowed to avoid 1000 cap)
# -----------------------------
def list_prs_window(token: str, user: str, start_d: date, end_d_exclusive: date, max_prs: int, warnings: list):
    # GitHub search cap (1000) を避けるため月単位分割。
    # “全期間”の要件なのでここは必須。
    q = (
        f"is:pr author:{user} is:merged "
        f"merged:{start_d.isoformat()}..{(end_d_exclusive - timedelta(days=1)).isoformat()}"
    )

    cursor = None
    out = []
    while True:
        data, errs = gql(token, PR_SEARCH, {"q": q, "cursor": cursor})

        # errors は部分失敗（SAML含む）があり得るので warnings に積む
        for e in errs:
            ext = e.get("extensions") or {}
            if ext.get("saml_failure") is True:
                warnings.append({
                    "type": "saml_failure",
                    "user": user,
                    "window": [str(start_d), str(end_d_exclusive)],
                    "message": e.get("message"),
                })
            else:
                warnings.append({
                    "type": "graphql_error",
                    "user": user,
                    "window": [str(start_d), str(end_d_exclusive)],
                    "message": e.get("message"),
                })

        s = (data.get("search") or {})
        nodes = s.get("nodes") or []
        out.extend(nodes)

        if len(out) >= max_prs:
            break

        pi = s.get("pageInfo") or {}
        if not pi.get("hasNextPage"):
            break
        cursor = pi.get("endCursor")
        time.sleep(0.12)

    return out

# -----------------------------
# PR files + download
# -----------------------------
def parse_repo(nwo: str):
    owner, repo = nwo.split("/", 1)
    return owner, repo

def list_pr_files(token: str, owner: str, repo: str, number: int):
    files = []
    page = 1
    while True:
        j = rest_get(token, f"/repos/{owner}/{repo}/pulls/{number}/files", params={"per_page": 100, "page": page})
        if not j:
            break
        files.extend(j)
        if len(j) < 100:
            break
        page += 1
        time.sleep(0.12)
    return files

def download_file(raw_url: str, token: str, dest: Path, max_bytes: int = 10 * 1024 * 1024):
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = requests.get(raw_url, headers=gh_headers(token), timeout=60)
    if r.status_code == 404:
        return False
    r.raise_for_status()
    if len(r.content) > max_bytes:
        return False
    dest.write_bytes(r.content)
    return True

# -----------------------------
# Linguist mapping
# -----------------------------
def run_linguist_file_map(root: Path) -> dict[str, str]:
    # Linguist が “generated/vendored/binary” 等を除外した上で
    # 言語ごとの files を返す想定。そこから file->lang を作る。
    cmd = ["github-linguist", "--breakdown", "--json", str(root)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or "github-linguist failed")
    j = json.loads(p.stdout)

    file_to_lang = {}
    for entry in j:
        lang = entry.get("name") or entry.get("language")
        files = entry.get("files") or []
        if not lang:
            continue
        for f in files:
            file_to_lang[str(f)] = lang
    return file_to_lang

# -----------------------------
# Pie output
# -----------------------------
def make_pie_svg(values: dict[str, int], out_svg: str, title: str):
    total = sum(values.values())
    items = sorted(values.items(), key=lambda x: x[1], reverse=True)

    major, other = [], 0
    for k, v in items:
        if total > 0 and v / total < 0.02:
            other += v
        else:
            major.append((k, v))
    if other > 0:
        major.append(("Other", other))

    labels = [k for k, _ in major]
    sizes = [v for _, v in major]

    plt.figure(figsize=(6, 6), dpi=160)
    plt.title(title)
    plt.pie(sizes, labels=labels, autopct=lambda p: f"{p:.1f}%" if p >= 4 else "")
    plt.tight_layout()
    plt.savefig(out_svg, format="svg")
    plt.close()

# -----------------------------
# Main
# -----------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--users", required=True, help="comma-separated: main,work")
    ap.add_argument("--metric", choices=["churn", "additions"], default="churn")
    ap.add_argument("--out-svg", required=True)
    ap.add_argument("--out-json", required=True)
    ap.add_argument("--max-prs-per-window", type=int, default=900)
    args = ap.parse_args()

    users = [u.strip() for u in args.users.split(",") if u.strip()]
    if len(users) != 2:
        print("This script expects exactly 2 users: main, work", file=sys.stderr)
        sys.exit(1)

    t_main = os.getenv("GH_TOKEN_MAIN")
    t_work = os.getenv("GH_TOKEN_WORK")
    if not t_main or not t_work:
        print("Missing secrets: GH_TOKEN_MAIN / GH_TOKEN_WORK", file=sys.stderr)
        sys.exit(1)
    tokens = [t_main, t_work]

    now = datetime.now(timezone.utc).date()

    lang_scores: dict[str, int] = {}
    pr_count = 0
    skipped_windows = []
    warnings = []
    errors = []

    for user, token in zip(users, tokens):
        # 片方が死んでももう片方は続行
        try:
            created_at = get_user_created_at(token, user).date()
        except Exception as e:
            errors.append({"user": user, "stage": "get_user_created_at", "error": str(e)})
            continue

        start = created_at if created_at.year >= 2008 else date(2008, 1, 1)

        for w_start, w_end in iter_month_windows(start, now + timedelta(days=1)):
            try:
                prs = list_prs_window(
                    token, user, w_start, w_end,
                    max_prs=args.max_prs_per_window,
                    warnings=warnings,
                )
            except Exception as e:
                errors.append({"user": user, "stage": "search_window", "window": [str(w_start), str(w_end)], "error": str(e)})
                continue

            if len(prs) >= args.max_prs_per_window:
                skipped_windows.append({
                    "user": user,
                    "start": str(w_start),
                    "end": str(w_end),
                    "reason": "too_many_prs_in_window",
                })
                continue

            for pr in prs:
                nwo = pr["repository"]["nameWithOwner"]
                owner, repo = parse_repo(nwo)
                number = pr["number"]

                try:
                    files = list_pr_files(token, owner, repo, number)
                except requests.HTTPError as e:
                    warnings.append({
                        "type": "rest_error",
                        "user": user,
                        "repo": nwo,
                        "pr": number,
                        "message": f"{e}",
                    })
                    continue

                # PRで触ったファイルを一時dirに復元して Linguist を走らせる
                with tempfile.TemporaryDirectory() as td:
                    root = Path(td)
                    pr_meta = []  # (path, additions, deletions)

                    for f in files:
                        path = f.get("filename")
                        raw_url = f.get("raw_url")
                        if not path or not raw_url:
                            continue
                        ok = download_file(raw_url, token, root / path)
                        if not ok:
                            continue
                        pr_meta.append((path, int(f.get("additions") or 0), int(f.get("deletions") or 0)))
                        time.sleep(0.02)

                    if not pr_meta:
                        continue

                    try:
                        file_to_lang = run_linguist_file_map(root)
                    except Exception as e:
                        warnings.append({
                            "type": "linguist_error",
                            "user": user,
                            "repo": nwo,
                            "pr": number,
                            "message": str(e),
                        })
                        continue

                    for path, add, dele in pr_meta:
                        lang = file_to_lang.get(path)
                        if not lang:
                            continue
                        score = add if args.metric == "additions" else (add + dele)
                        if score <= 0:
                            continue
                        lang_scores[lang] = lang_scores.get(lang, 0) + score

                pr_count += 1
                time.sleep(0.03)

    # Output
    os.makedirs(os.path.dirname(args.out_svg), exist_ok=True)
    os.makedirs(os.path.dirname(args.out_json), exist_ok=True)

    title = f"PR Diff Languages (Linguist, all time, metric={args.metric})"
    make_pie_svg(lang_scores, args.out_svg, title)

    with open(args.out_json, "w", encoding="utf-8") as w:
        json.dump(
            {
                "users": users,
                "metric": args.metric,
                "scope": "all_time",
                "processed_pr_count": pr_count,
                "skipped_windows": skipped_windows,
                "warnings": warnings,
                "errors": errors,
                "scores": lang_scores,
            },
            w,
            ensure_ascii=False,
            indent=2,
        )

if __name__ == "__main__":
    main()
