import argparse, os, sys, time, json, tempfile, subprocess, math
from datetime import datetime, timedelta, timezone, date
from pathlib import Path

import requests
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

GITHUB_API = "https://api.github.com"
GITHUB_GQL = "https://api.github.com/graphql"

def gh_headers(token: str):
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pr-lang-pie-linguist-alltime",
    }

def gql(token: str, query: str, variables: dict):
    r = requests.post(GITHUB_GQL, headers=gh_headers(token), json={"query": query, "variables": variables}, timeout=60)
    r.raise_for_status()
    j = r.json()
    if "errors" in j:
        raise RuntimeError(j["errors"])
    return j["data"]

def rest_get(token: str, path: str, params=None):
    r = requests.get(f"{GITHUB_API}{path}", headers=gh_headers(token), params=params, timeout=60)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()

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
    d = gql(token, USER_CREATED, {"login": login})
    s = d["user"]["createdAt"]
    # ISO8601 -> datetime
    return datetime.fromisoformat(s.replace("Z", "+00:00"))

def month_start(d: date) -> date:
    return date(d.year, d.month, 1)

def add_month(d: date) -> date:
    y, m = d.year, d.month
    if m == 12:
        return date(y + 1, 1, 1)
    return date(y, m + 1, 1)

def iter_month_windows(start: date, end_exclusive: date):
    cur = month_start(start)
    while cur < end_exclusive:
        nxt = add_month(cur)
        yield cur, min(nxt, end_exclusive)
        cur = nxt

def list_prs_window(token: str, user: str, start_d: date, end_d_exclusive: date, max_prs: int):
    # Search は 1000上限があるため、月単位で分割して取り切る。
    # ここでは merged PR を対象。全期間で「closed」も入れるなら is:merged を外す。
    q = (
        f"is:pr author:{user} is:merged "
        f"merged:{start_d.isoformat()}..{(end_d_exclusive - timedelta(days=1)).isoformat()}"
    )

    cursor = None
    out = []
    while True:
        data = gql(token, PR_SEARCH, {"q": q, "cursor": cursor})
        s = data["search"]
        out.extend(s["nodes"])
        if len(out) >= max_prs:
            # 1ウィンドウで多すぎる場合は設計ミス（週分割などに変更）
            break
        if not s["pageInfo"]["hasNextPage"]:
            break
        cursor = s["pageInfo"]["endCursor"]
        time.sleep(0.15)

    return out

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
        time.sleep(0.15)
    return files

def download_file(raw_url: str, token: str, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = requests.get(raw_url, headers=gh_headers(token), timeout=60)
    if r.status_code == 404:
        return False
    r.raise_for_status()
    # 巨大ファイル対策：10MB超は無視（linguistに投げても重い）
    if len(r.content) > 10 * 1024 * 1024:
        return False
    dest.write_bytes(r.content)
    return True

def run_linguist_file_map(root: Path) -> dict[str, str]:
    # linguistの “generated/vendored/binary” 除外に寄せる
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

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--users", required=True)
    ap.add_argument("--metric", choices=["churn", "additions"], default="churn")
    ap.add_argument("--out-svg", required=True)
    ap.add_argument("--out-json", required=True)
    ap.add_argument("--window", choices=["month"], default="month")
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

    for user, token in zip(users, tokens):
        # そのユーザーが作られた日から開始（それ以前はPRがない）
        created_at = get_user_created_at(token, user).date()
        start = created_at if created_at.year >= 2008 else date(2008, 1, 1)

        for w_start, w_end in iter_month_windows(start, now + timedelta(days=1)):
            prs = list_prs_window(token, user, w_start, w_end, max_prs=args.max_prs_per_window)

            if len(prs) >= args.max_prs_per_window:
                # 1ヶ月で上限に達した＝この月が多すぎる。週分割実装も可能だが、まず警告として残す。
                skipped_windows.append({"user": user, "start": str(w_start), "end": str(w_end), "reason": "too_many_prs_in_window"})
                continue

            for pr in prs:
                nwo = pr["repository"]["nameWithOwner"]
                owner, repo = parse_repo(nwo)
                number = pr["number"]

                try:
                    files = list_pr_files(token, owner, repo, number)
                except requests.HTTPError:
                    continue

                with tempfile.TemporaryDirectory() as td:
                    root = Path(td)
                    pr_meta = []
                    for f in files:
                        path = f.get("filename")
                        raw_url = f.get("raw_url")
                        if not path or not raw_url:
                            continue
                        ok = download_file(raw_url, token, root / path)
                        if not ok:
                            continue
                        pr_meta.append((path, int(f.get("additions") or 0), int(f.get("deletions") or 0)))
                        time.sleep(0.03)

                    if not pr_meta:
                        continue

                    try:
                        file_to_lang = run_linguist_file_map(root)
                    except Exception:
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
                time.sleep(0.06)

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
                "scores": lang_scores,
            },
            w,
            ensure_ascii=False,
            indent=2,
        )

if __name__ == "__main__":
    main()
