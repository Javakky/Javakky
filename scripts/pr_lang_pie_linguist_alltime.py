import argparse
import json
import os
import sys
import time
import tempfile
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone, date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

GITHUB_API = "https://api.github.com"
GITHUB_GQL = "https://api.github.com/graphql"


# -----------------------------
# utils
# -----------------------------
def log(msg: str):
    print(msg, flush=True)


def clamp_sleep(sec: float):
    # CIで過剰に遅くしない程度のスロットル
    if sec <= 0:
        return
    time.sleep(sec)


# -----------------------------
# GitHub API helpers
# -----------------------------
def gh_headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pr-lang-pie-linguist-alltime",
    }


def gql(token: str, query: str, variables: dict) -> Tuple[dict, list]:
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


def rest_get(token: str, path: str, params=None) -> Any:
    r = requests.get(
        f"{GITHUB_API}{path}",
        headers=gh_headers(token),
        params=params,
        timeout=60,
    )
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
def list_prs_window(
        token: str,
        user: str,
        start_d: date,
        end_d_exclusive: date,
        max_prs: int,
        warnings: list,
) -> List[dict]:
    q = (
        f"is:pr author:{user} is:merged "
        f"merged:{start_d.isoformat()}..{(end_d_exclusive - timedelta(days=1)).isoformat()}"
    )

    cursor = None
    out: List[dict] = []
    while True:
        data, errs = gql(token, PR_SEARCH, {"q": q, "cursor": cursor})

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
        clamp_sleep(0.12)

    return out


# -----------------------------
# PR files + download
# -----------------------------
def parse_repo(nwo: str) -> Tuple[str, str]:
    owner, repo = nwo.split("/", 1)
    return owner, repo


def list_pr_files(token: str, owner: str, repo: str, number: int) -> List[dict]:
    files: List[dict] = []
    page = 1
    while True:
        j = rest_get(
            token,
            f"/repos/{owner}/{repo}/pulls/{number}/files",
            params={"per_page": 100, "page": page},
        )
        if not j:
            break
        files.extend(j)
        if len(j) < 100:
            break
        page += 1
        clamp_sleep(0.12)
    return files


def download_file(
        raw_url: str,
        token: str,
        dest: Path,
        max_bytes: int = 10 * 1024 * 1024,
) -> Tuple[bool, Optional[int], Optional[str]]:
    """
    returns: (ok, status_code, reason)
      ok=False でも HTTPError は投げない（理由を返す）
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = requests.get(raw_url, headers=gh_headers(token), timeout=60)
    except Exception as e:
        return False, None, f"request_error:{e}"

    if r.status_code == 404:
        return False, 404, "not_found"
    if r.status_code == 403:
        # SSO/権限/レート等を疑う
        return False, 403, "forbidden"
    if r.status_code >= 400:
        return False, r.status_code, f"http_{r.status_code}"

    content = r.content
    if len(content) > max_bytes:
        return False, 200, f"too_large:{len(content)}"

    try:
        dest.write_bytes(content)
    except Exception as e:
        return False, 200, f"write_error:{e}"

    return True, 200, None


# -----------------------------
# Linguist mapping
# -----------------------------
def run_linguist_file_map(root: Path) -> Dict[str, str]:
    """
    github-linguist --breakdown --json の出力形式はバージョン差があり得るので
    list/dict 両方を吸収して file->lang を作る。
    """
    cmd = ["github-linguist", "--breakdown", "--json", str(root)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or "github-linguist failed")

    raw = (p.stdout or "").strip()
    if not raw:
        raise RuntimeError("github-linguist returned empty stdout")

    j = json.loads(raw)

    entries: Optional[List[dict]] = None
    if isinstance(j, list):
        entries = [x for x in j if isinstance(x, dict)]
    elif isinstance(j, dict):
        # よくあるキー候補
        for k in ("languages", "breakdown", "data"):
            if k in j and isinstance(j[k], list):
                entries = [x for x in j[k] if isinstance(x, dict)]
                break
        if entries is None:
            # dictが language->info の形なら items から組み立て
            tmp: List[dict] = []
            for lang, info in j.items():
                if isinstance(info, dict):
                    e = dict(info)
                    e["name"] = e.get("name") or lang
                    tmp.append(e)
            if tmp:
                entries = tmp

    if not entries:
        # 形式が想定外なら落とす（ここが0になると永遠に気づけない）
        keys = list(j.keys()) if isinstance(j, dict) else None
        raise RuntimeError(f"Unexpected linguist JSON format: type={type(j)} keys={keys}")

    file_to_lang: Dict[str, str] = {}
    for entry in entries:
        lang = entry.get("name") or entry.get("language")
        files = entry.get("files") or []
        if not lang:
            continue
        for f in files:
            file_to_lang[str(f)] = str(lang)

    return file_to_lang


# -----------------------------
# Pie output
# -----------------------------
def make_pie_svg(values: Dict[str, int], out_svg: str, title: str):
    total = sum(values.values())
    items = sorted(values.items(), key=lambda x: x[1], reverse=True)

    major: List[Tuple[str, int]] = []
    other = 0
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
    plt.pie(
        sizes,
        labels=labels,
        autopct=lambda p: f"{p:.1f}%" if p >= 4 else "",
    )
    plt.tight_layout()
    plt.savefig(out_svg, format="svg")
    plt.close()


# -----------------------------
# Main
# -----------------------------
@dataclass
class Counters:
    windows_total: int = 0
    windows_prs_found: int = 0
    prs_seen: int = 0
    prs_processed: int = 0

    files_api_calls: int = 0
    files_api_total_files: int = 0

    downloads_ok: int = 0
    downloads_404: int = 0
    downloads_403: int = 0
    downloads_other: int = 0
    downloads_too_large: int = 0

    linguist_runs: int = 0
    linguist_mapped_files: int = 0
    scored_files: int = 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--users", required=True, help="comma-s_
