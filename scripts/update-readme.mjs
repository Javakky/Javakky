import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PERSONAL_USER = mustEnv("PERSONAL_USER");
const WORK_USER = mustEnv("WORK_USER");
const GH_TOKEN_MAIN = mustEnv("GH_TOKEN_MAIN");
const GH_TOKEN_WORK = mustEnv("GH_TOKEN_WORK");

const MAX_REPOS_TO_CLONE = parseInt(process.env.MAX_REPOS_TO_CLONE ?? "200", 10);
const README_MARKER_START = process.env.README_MARKER_START ?? "<!-- PROFILE_AUTOGEN:START -->";
const README_MARKER_END = process.env.README_MARKER_END ?? "<!-- PROFILE_AUTOGEN:END -->";

// 除外 org（owner.login が一致したら落とす）
const EXCLUDE_ORGS = new Set(
    (process.env.EXCLUDE_ORGS ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.toLowerCase())
);

const OWNER_REPO = `${PERSONAL_USER}/${PERSONAL_USER}`; // プロフィール用 repo 想定

async function main() {
    assertInGitRepo();

    // 1) private を含めて owned repos を取る（/user/repos）
    const personalOwned = await listOwnedReposAuthed(GH_TOKEN_MAIN);
    const workOwned = await listOwnedReposAuthed(GH_TOKEN_WORK);

    // 2) merged PR 経由で repo を拾う（owner じゃない repo も含む）
    const personalMergedPrRepos = await listReposFromMergedPullRequests(PERSONAL_USER, GH_TOKEN_MAIN);
    const workMergedPrRepos = await listReposFromMergedPullRequests(WORK_USER, GH_TOKEN_WORK);

    // 3) repoSet（full_name -> repo）
    const repoSet = new Map();
    for (const r of [...personalOwned, ...workOwned]) repoSet.set(r.full_name, r);

    // PR 経由 repo は不足情報を /repos/:full_name で補完（private は権限がなければ落とす）
    for (const r of [...personalMergedPrRepos, ...workMergedPrRepos]) {
        if (repoSet.has(r.full_name)) continue;
        const token = pickTokenForRepo(r.full_name);
        const hydrated = await tryGetRepo(r.full_name, token);
        if (hydrated) repoSet.set(hydrated.full_name, hydrated);
    }

    // 4) fork/archived/org 除外、プロフィール repo 自身除外
    const filtered = [...repoSet.values()].filter(r => {
        if (r.full_name === OWNER_REPO) return false;
        if (r.fork) return false;      // fork 除外
        if (r.archived) return false;  // archived 除外
        const owner = (r.owner_login ?? "").toLowerCase();
        if (owner && EXCLUDE_ORGS.has(owner)) return false; // 特定 org 除外
        return true;
    });

    // 5) clone 対象（最近更新順、上限）
    const repos = filtered
        .sort((a, b) => (new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime()))
        .slice(0, MAX_REPOS_TO_CLONE);

    // 6) clone & linguist 集計（ログで必ず clone 元を吐く）
    ensureBundler();
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "profile-langs-"));
    const langBytes = new Map();

    for (const r of repos) {
        const targetDir = path.join(tmpBase, r.full_name.replace("/", "__"));
        const token = pickTokenForRepo(r.full_name);

        console.log(`[CLONE] ${r.full_name} -> ${targetDir}`); // ★要件：clone 元をログ
        try {
            shallowClone(r.clone_url, token, targetDir, r.default_branch);
        } catch (e) {
            console.warn(`[WARN] clone failed, skip: ${r.full_name}`);
            continue;
        }

        const linguist = runLinguistJson(targetDir);
        for (const [lang, bytes] of Object.entries(linguist)) {
            langBytes.set(lang, (langBytes.get(lang) ?? 0) + Number(bytes));
        }
    }

    // 7) Stats / 草：GraphQL contributionsCollection を両アカウント分取得してマージ
    const personalContrib = await getContrib(PERSONAL_USER, GH_TOKEN_MAIN);
    const workContrib = await getContrib(WORK_USER, GH_TOKEN_WORK);
    const merged = mergeContrib(personalContrib, workContrib);

    // 8) README 差し込み
    const topLangs = toTopLangs(langBytes, 12);
    const md = buildMarkdownBlock({
        generatedAt: new Date().toISOString(),
        users: { personal: PERSONAL_USER, work: WORK_USER },
        excludeOrgs: [...EXCLUDE_ORGS],
        repoCount: {
            before: repoSet.size,
            after: filtered.length,
            cloned: repos.length
        },
        topLangs,
        stats: merged.stats,
        heatmapSvg: buildHeatmapSvg(merged.calendarByDate)
    });

    const readmePath = path.join(process.cwd(), "README.md");
    const current = fs.readFileSync(readmePath, "utf8");
    const next = replaceBetweenMarkers(current, README_MARKER_START, README_MARKER_END, md);
    fs.writeFileSync(readmePath, next, "utf8");

    console.log("README.md updated.");
}

function mustEnv(key) {
    const v = process.env[key];
    if (!v) throw new Error(`Missing env: ${key}`);
    return v;
}

function assertInGitRepo() {
    exec("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
}

function ensureBundler() {
    exec("bundle", ["exec", "github-linguist", "--version"], { stdio: "inherit" });
}

function exec(cmd, args, opts = {}) {
    return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

async function ghJson(url, token) {
    const res = await fetch(url, {
        headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28"
        }
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub API failed: ${res.status} ${res.statusText}\n${url}\n${text}`);
    }
    return await res.json();
}

/**
 * private を含めて “認証ユーザーが owner の repo” を取る
 * - /user/repos は token の主体ユーザーに紐づく
 */
async function listOwnedReposAuthed(token) {
    const out = [];
    let page = 1;
    while (true) {
        const url =
            `https://api.github.com/user/repos?per_page=100&page=${page}` +
            `&affiliation=owner&sort=pushed&direction=desc&visibility=all`;
        const batch = await ghJson(url, token);

        for (const r of batch) {
            out.push(normalizeRepo(r));
        }
        if (batch.length < 100) break;
        page++;
    }
    return out;
}

/**
 * PR は merged のみ（Search API）
 * - is:pr is:merged author:<user>
 */
async function listReposFromMergedPullRequests(user, token) {
    const out = new Map(); // full_name -> normalized repo
    let page = 1;

    while (page <= 10) {
        const q = `is:pr is:merged author:${user}`;
        const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;
        const data = await ghJson(url, token);

        for (const item of data.items ?? []) {
            const repoUrl = item.repository_url; // https://api.github.com/repos/owner/name
            if (!repoUrl) continue;

            try {
                const repo = await ghJson(repoUrl, token);
                out.set(repo.full_name, normalizeRepo(repo));
            } catch {
                // 権限がなく見えない private repo などはここで落ちる。要件上は「可能なら含める」なのでスキップ。
                continue;
            }
        }

        if ((data.items ?? []).length < 100) break;
        page++;
    }

    return [...out.values()];
}

async function tryGetRepo(fullName, token) {
    try {
        const url = `https://api.github.com/repos/${fullName}`;
        const r = await ghJson(url, token);
        return normalizeRepo(r);
    } catch {
        return null;
    }
}

function normalizeRepo(r) {
    return {
        full_name: r.full_name,
        clone_url: r.clone_url,
        default_branch: r.default_branch,
        pushed_at: r.pushed_at,
        fork: Boolean(r.fork),
        archived: Boolean(r.archived),
        owner_login: r.owner?.login ?? ""
    };
}

function pickTokenForRepo(fullName) {
    const [owner] = fullName.split("/");
    if (owner.toLowerCase() === WORK_USER.toLowerCase()) return GH_TOKEN_WORK;
    return GH_TOKEN_MAIN;
}

function shallowClone(cloneUrl, token, targetDir, branch) {
    fs.mkdirSync(targetDir, { recursive: true });

    const authed = cloneUrl.replace(
        "https://",
        `https://x-access-token:${token}@`
    );

    exec("git", ["clone", "--depth", "1", "--branch", branch, authed, targetDir], { stdio: "inherit" });
}

function runLinguistJson(repoDir) {
    const json = exec("bundle", ["exec", "github-linguist", "--json", repoDir], { stdio: "pipe" });
    try {
        return JSON.parse(json);
    } catch {
        console.warn(`[WARN] linguist json parse failed: ${repoDir}`);
        return {};
    }
}

function toTopLangs(langBytes, n) {
    const entries = [...langBytes.entries()].sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, b]) => s + b, 0);
    return entries.slice(0, n).map(([lang, bytes]) => ({
        lang,
        bytes,
        pct: total > 0 ? (bytes / total) : 0
    }));
}

async function ghGraphql(token, query, variables) {
    const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ query, variables })
    });
    const json = await res.json();
    if (json.errors?.length) {
        throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
    }
    return json.data;
}

async function getContrib(user, token) {
    const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalRepositoryContributions
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;
    const data = await ghGraphql(token, query, { login: user });
    const cc = data.user.contributionsCollection;

    const calendarByDate = new Map();
    for (const w of cc.contributionCalendar.weeks) {
        for (const d of w.contributionDays) {
            calendarByDate.set(d.date, d.contributionCount);
        }
    }
    return {
        stats: {
            commits: cc.totalCommitContributions,
            issues: cc.totalIssueContributions,
            prs: cc.totalPullRequestContributions,
            repos: cc.totalRepositoryContributions,
            total: cc.contributionCalendar.totalContributions
        },
        calendarByDate
    };
}

function mergeContrib(a, b) {
    const calendarByDate = new Map();
    for (const [date, count] of a.calendarByDate.entries()) calendarByDate.set(date, count);
    for (const [date, count] of b.calendarByDate.entries()) {
        calendarByDate.set(date, (calendarByDate.get(date) ?? 0) + count);
    }
    return {
        stats: {
            commits: a.stats.commits + b.stats.commits,
            issues: a.stats.issues + b.stats.issues,
            prs: a.stats.prs + b.stats.prs,
            repos: a.stats.repos + b.stats.repos,
            total: a.stats.total + b.stats.total
        },
        calendarByDate
    };
}

function buildMarkdownBlock({ generatedAt, users, excludeOrgs, repoCount, topLangs, stats, heatmapSvg }) {
    const langLines =
        topLangs.length === 0
            ? `- (no data)`
            : topLangs.map(l => `- ${l.lang}: ${(l.pct * 100).toFixed(1)}% (${formatBytes(l.bytes)})`).join("\n");

    const excludeLine = excludeOrgs.length ? excludeOrgs.map(s => `\`${s}\``).join(", ") : "(none)";

    return [
        `${README_MARKER_START}`,
        ``,
        `### Profile Stats (merged)`,
        ``,
        `- users: \`${users.personal}\` + \`${users.work}\``,
        `- total contributions (last ~1y): **${stats.total}**`,
        `- PR: **${stats.prs}** / Issue: **${stats.issues}** / Commit: **${stats.commits}** / Repo: **${stats.repos}**`,
        ``,
        `### Repo filters`,
        ``,
        `- exclude forks: yes`,
        `- exclude archived: yes`,
        `- exclude orgs: ${excludeLine}`,
        `- repos: ${repoCount.before} -> ${repoCount.after} (cloned: ${repoCount.cloned})`,
        ``,
        `### Languages (Linguist, aggregated from cloned repos)`,
        ``,
        langLines,
        ``,
        `### Activity (merged heatmap)`,
        ``,
        heatmapSvg,
        ``,
        `updated: \`${generatedAt}\``,
        ``,
        `${README_MARKER_END}`
    ].join("\n");
}

function replaceBetweenMarkers(text, start, end, replacementBlock) {
    const s = text.indexOf(start);
    const e = text.indexOf(end);
    if (s === -1 || e === -1 || e < s) {
        return `${text.trimEnd()}\n\n${replacementBlock}\n`;
    }
    const before = text.slice(0, s);
    const after = text.slice(e + end.length);
    return `${before}${replacementBlock}${after}`;
}

function formatBytes(n) {
    const units = ["B", "KB", "MB", "GB"];
    let x = n;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) {
        x /= 1024;
        i++;
    }
    return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function buildHeatmapSvg(calendarByDate) {
    const dates = [...calendarByDate.keys()].sort();
    if (dates.length === 0) return "_no data_";

    const max = Math.max(...dates.map(d => calendarByDate.get(d) ?? 0));
    const levelOf = (c) => {
        if (c <= 0) return 0;
        if (max <= 0) return 1;
        const lvl = Math.ceil((c / max) * 4);
        return Math.min(4, Math.max(1, lvl));
    };

    const colors = ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"];

    const last = new Date(dates[dates.length - 1] + "T00:00:00Z");
    const days = 53 * 7;

    const cells = [];
    for (let i = days - 1; i >= 0; i--) {
        const dt = new Date(last);
        dt.setUTCDate(dt.getUTCDate() - i);
        const key = dt.toISOString().slice(0, 10);
        const c = calendarByDate.get(key) ?? 0;
        cells.push({ key, c, level: levelOf(c) });
    }

    const cell = 11;
    const gap = 2;
    const width = 53 * (cell + gap) + 20;
    const height = 7 * (cell + gap) + 20;

    let rects = "";
    for (let idx = 0; idx < cells.length; idx++) {
        const col = Math.floor(idx / 7);
        const row = idx % 7;
        const x = 10 + col * (cell + gap);
        const y = 10 + row * (cell + gap);
        const fill = colors[cells[idx].level];
        const title = `${cells[idx].key}: ${cells[idx].c}`;
        rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${fill}"><title>${escapeXml(title)}</title></rect>`;
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${rects}
</svg>`;

    return `\n${svg}\n`;
}

function escapeXml(s) {
    return s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
