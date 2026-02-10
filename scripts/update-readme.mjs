/**
 * scripts/update-readme.mjs  (FULL)
 *
 * ✅ Features
 * - owned repos (personal+work, include private where token allows) via /user/repos
 * - merged PR repos via Search API (is:pr is:merged author:<user>)
 * - merge repo sets (hydrate missing via /repos/{full_name})
 * - filters:
 *    - exclude forks (except allowlist)
 *    - exclude archived
 *    - exclude orgs (by owner.login)
 *    - exclude profile repo itself
 * - clone (shallow) each repo safely (handles empty repo / missing default branch)
 * - github-linguist --json aggregation (robust parsing for multiple JSON shapes)
 * - per-repo debug logs (clone/head/linguist keys/bytes/top langs + sample)
 * - GraphQL contributionsCollection for both users; robust fallback when schema differs
 * - output:
 *    - README.md between markers
 *    - SVG assets are written to assets/ (stable display via <img> rather than raw inline svg)
 */

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

const OWNER_REPO = process.env.PROFILE_REPO_FULLNAME
    ? process.env.PROFILE_REPO_FULLNAME
    : `${PERSONAL_USER}/${PERSONAL_USER}`; // default assumption

// Exclude orgs (owner.login match)
const EXCLUDE_ORGS = new Set(
    (process.env.EXCLUDE_ORGS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.toLowerCase())
);

// Allow fork repos explicitly (forkでも含めたい repo)
const ALLOW_FORK_REPOS = new Set(
    (process.env.ALLOW_FORK_REPOS ?? "play-swagger/play-swagger")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.toLowerCase())
);

// Output
const ASSETS_DIR = process.env.ASSETS_DIR ?? "assets";
const ASSET_PREFIX = process.env.ASSET_PREFIX ?? "profile"; // file prefix
const LANG_TOP_N = parseInt(process.env.LANG_TOP_N ?? "12", 10);

async function main() {
    assertInGitRepo();
    ensureBundler();

    // Prepare assets dir
    fs.mkdirSync(path.join(process.cwd(), ASSETS_DIR), { recursive: true });

    // 1) Owned repos (private included if token permits)
    const personalOwned = await listOwnedReposAuthed(GH_TOKEN_MAIN);
    const workOwned = await listOwnedReposAuthed(GH_TOKEN_WORK);

    // 2) Repos from merged PRs (Search API)
    const personalMergedPrRepos = await listReposFromMergedPullRequests(PERSONAL_USER, GH_TOKEN_MAIN);
    const workMergedPrRepos = await listReposFromMergedPullRequests(WORK_USER, GH_TOKEN_WORK);

    // 3) Merge repo set
    const repoSet = new Map();
    for (const r of [...personalOwned, ...workOwned]) repoSet.set(r.full_name, r);

    // Hydrate PR repos if not exist
    for (const r of [...personalMergedPrRepos, ...workMergedPrRepos]) {
        if (repoSet.has(r.full_name)) continue;
        const token = pickTokenForRepo(r.full_name);
        const hydrated = await tryGetRepo(r.full_name, token);
        if (hydrated) repoSet.set(hydrated.full_name, hydrated);
    }

    // 4) Filters
    const filtered = [...repoSet.values()].filter((r) => {
        if (r.full_name === OWNER_REPO) return false;

        // fork is excluded by default, but allowlisted fork repos are included
        if (r.fork && !ALLOW_FORK_REPOS.has(r.full_name.toLowerCase())) return false;

        if (r.archived) return false;

        const owner = (r.owner_login ?? "").toLowerCase();
        if (owner && EXCLUDE_ORGS.has(owner)) return false;

        return true;
    });

    // 5) Select clone targets (by pushed_at desc)
    const repos = filtered
        .sort((a, b) => new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime())
        .slice(0, MAX_REPOS_TO_CLONE);

    // 6) Clone + linguist aggregation with strong debug
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "profile-langs-"));
    const langBytes = new Map();

    let cloneOk = 0;
    let cloneFail = 0;
    let headMissing = 0;
    let linguistOk = 0;
    let linguistEmptyOrFail = 0;

    for (const r of repos) {
        const targetDir = path.join(tmpBase, r.full_name.replace("/", "__"));
        const token = pickTokenForRepo(r.full_name);

        const branch = r.default_branch && r.default_branch.trim() ? r.default_branch.trim() : "";
        console.log(`[CLONE] ${r.full_name} (branch=${branch || "(default)"}) -> ${targetDir}`);

        let cloned = false;
        try {
            shallowCloneSmart(r.clone_url, token, targetDir, branch);
            cloned = true;
            cloneOk++;
        } catch (e) {
            console.warn(`[WARN] clone failed, skip: ${r.full_name}`);
            console.warn(String(e?.message ?? e));
            cloneFail++;
            continue;
        }

        const headOk = cloned ? checkHeadOk(targetDir) : false;
        if (!headOk) headMissing++;

        const linguist = runLinguistJsonSafe(targetDir, r.full_name);
        const { ok, keys, bytesSum, topPreview, sample } = summarizeLinguist(linguist);

        if (ok) linguistOk++;
        else linguistEmptyOrFail++;

        // Per-repo debug
        if (ok) {
            console.log(
                `[DBG][REPO] ${r.full_name} headOk=${headOk ? "yes" : "no"} keys=${keys} bytes=${bytesSum} top=${JSON.stringify(
                    topPreview
                )}`
            );
        } else {
            console.log(
                `[DBG][REPO] ${r.full_name} headOk=${headOk ? "yes" : "no"} keys=${keys} bytes=0 top=[] sample=${JSON.stringify(
                    sample
                )}`
            );
        }

        // Aggregate (robust bytes extraction)
        for (const [lang, v] of Object.entries(linguist)) {
            const n = extractBytes(v);
            if (n == null || n <= 0) continue;
            langBytes.set(lang, (langBytes.get(lang) ?? 0) + n);
        }
    }

    const topLangs = toTopLangs(langBytes, LANG_TOP_N);
    const totalBytes = [...langBytes.values()].reduce((s, n) => s + n, 0);
    const langKeys = [...langBytes.keys()];

    console.log(`[DBG] cloneOk = ${cloneOk} cloneFail = ${cloneFail}`);
    console.log(`[DBG] headMissing = ${headMissing}`);
    console.log(`[DBG] linguistOk = ${linguistOk} linguistEmptyOrFail = ${linguistEmptyOrFail}`);
    console.log(`[DBG] totalBytes = ${totalBytes}`);
    console.log(`[DBG] topLangs length = ${topLangs.length}`);
    console.log(`[DBG] topLangs head = ${JSON.stringify(topLangs.slice(0, 3))}`);
    console.log(`[DBG] langKeys head = ${JSON.stringify(langKeys.slice(0, 10))}`);

    // 7) Contributions via GraphQL (robust fallback)
    const personalContrib = await getContribRobust(PERSONAL_USER, GH_TOKEN_MAIN);
    const workContrib = await getContribRobust(WORK_USER, GH_TOKEN_WORK);
    const merged = mergeContrib(personalContrib, workContrib);

    // 8) Render assets (stable display: use <img src="..."> with committed svg)
    const generatedAt = new Date().toISOString();

    const statsSvg = buildStatsCardsSvg({
        users: { personal: PERSONAL_USER, work: WORK_USER },
        stats: merged.stats,
        repoCount: { before: repoSet.size, after: filtered.length, cloned: repos.length },
    });

    const langsSvg = buildLangBarsSvg({
        title: "PR Diff Languages (All time, Linguist-based)",
        items: topLangs,
        note: `repos cloned: ${repos.length} / filtered: ${filtered.length} / total unique: ${repoSet.size}`,
    });

    const heatmapSvg = buildHeatmapSvg(merged.calendarByDate);

    // Write assets
    const statsPath = path.join(ASSETS_DIR, `${ASSET_PREFIX}-stats.svg`);
    const langsPath = path.join(ASSETS_DIR, `${ASSET_PREFIX}-langs.svg`);
    const heatPath = path.join(ASSETS_DIR, `${ASSET_PREFIX}-heatmap.svg`);
    fs.writeFileSync(path.join(process.cwd(), statsPath), statsSvg, "utf8");
    fs.writeFileSync(path.join(process.cwd(), langsPath), langsSvg, "utf8");
    fs.writeFileSync(path.join(process.cwd(), heatPath), heatmapSvg, "utf8");

    // 9) README block
    const md = buildMarkdownBlock({
        generatedAt,
        users: { personal: PERSONAL_USER, work: WORK_USER },
        excludeOrgs: [...EXCLUDE_ORGS],
        allowForkRepos: [...ALLOW_FORK_REPOS],
        repoCount: { before: repoSet.size, after: filtered.length, cloned: repos.length },
        topLangs,
        assets: { statsPath, langsPath, heatPath },
        stats: merged.stats,
    });

    const readmePath = path.join(process.cwd(), "README.md");
    const current = fs.readFileSync(readmePath, "utf8");
    const next = replaceBetweenMarkers(current, README_MARKER_START, README_MARKER_END, md);
    fs.writeFileSync(readmePath, next, "utf8");

    console.log("README.md updated.");
}

/* ------------------------- env / shell ------------------------- */

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

/* ------------------------- fetch with retry ------------------------- */

async function fetchWithRetry(url, init, { tries = 4, baseDelayMs = 600 } = {}) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url, init);
            return res;
        } catch (e) {
            lastErr = e;
            const delay = baseDelayMs * Math.pow(2, i);
            await sleep(delay);
        }
    }
    throw lastErr;
}

async function sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
}

/* ------------------------- GitHub REST ------------------------- */

async function ghJson(url, token) {
    const res = await fetchWithRetry(
        url,
        {
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
            },
        },
        { tries: 4, baseDelayMs: 600 }
    );

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub API failed: ${res.status} ${res.statusText}\n${url}\n${text}`);
    }
    return await res.json();
}

/**
 * Get “repos owned by the authenticated user”
 * /user/repos is bound to the token owner
 */
async function listOwnedReposAuthed(token) {
    const out = [];
    let page = 1;
    while (true) {
        const url =
            `https://api.github.com/user/repos?per_page=100&page=${page}` +
            `&affiliation=owner&sort=pushed&direction=desc&visibility=all`;
        const batch = await ghJson(url, token);
        for (const r of batch) out.push(normalizeRepo(r));
        if (batch.length < 100) break;
        page++;
    }
    return out;
}

/**
 * List repos from merged PRs (Search API)
 * is:pr is:merged author:<user>
 */
async function listReposFromMergedPullRequests(user, token) {
    const out = new Map(); // full_name -> normalized repo
    let page = 1;

    while (page <= 10) {
        const q = `is:pr is:merged author:${user}`;
        const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;
        const data = await ghJson(url, token);

        for (const item of data.items ?? []) {
            const repoUrl = item.repository_url;
            if (!repoUrl) continue;
            try {
                const repo = await ghJson(repoUrl, token);
                out.set(repo.full_name, normalizeRepo(repo));
            } catch {
                // private repos not visible by this token
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
        owner_login: r.owner?.login ?? "",
    };
}

function pickTokenForRepo(fullName) {
    const [owner] = fullName.split("/");
    if (owner.toLowerCase() === WORK_USER.toLowerCase()) return GH_TOKEN_WORK;
    return GH_TOKEN_MAIN;
}

/* ------------------------- git clone / linguist ------------------------- */

function shallowCloneSmart(cloneUrl, token, targetDir, branch) {
    fs.mkdirSync(targetDir, { recursive: true });

    const authed = cloneUrl.replace("https://", `https://x-access-token:${token}@`);

    // 1) Try branch-specified clone if branch provided
    if (branch) {
        try {
            exec("git", ["clone", "--depth", "1", "--branch", branch, authed, targetDir], { stdio: "inherit" });
            return;
        } catch {
            // continue
        }
    }

    // 2) Fallback: normal shallow clone
    exec("git", ["clone", "--depth", "1", authed, targetDir], { stdio: "inherit" });
}

function checkHeadOk(repoDir) {
    try {
        exec("git", ["-C", repoDir, "rev-parse", "--verify", "HEAD"], { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

function runLinguistJsonSafe(repoDir, fullNameForLog) {
    try {
        const json = exec("bundle", ["exec", "github-linguist", "--json", repoDir], { stdio: "pipe" });
        return JSON.parse(json);
    } catch (e) {
        console.warn(`[WARN] linguist failed, skip: ${fullNameForLog}`);
        return {};
    }
}

/**
 * github-linguist --json の出力が揺れても bytes を抽出できるようにする
 */
function extractBytes(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;

    if (typeof v === "string") {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    if (v && typeof v === "object") {
        const b = v.bytes ?? v.size ?? v.totalBytes;
        const n = Number(b);
        return Number.isFinite(n) ? n : null;
    }

    return null;
}

function summarizeLinguist(linguist) {
    const entries = Object.entries(linguist ?? {})
        .map(([k, v]) => [k, extractBytes(v)])
        .filter(([, n]) => n != null && Number.isFinite(n));

    const keys = Object.keys(linguist ?? {}).length;
    const bytesSum = entries.reduce((s, [, n]) => s + n, 0);

    const topPreview = entries
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, n]) => [k, n]);

    const ok = entries.length > 0 && bytesSum > 0;

    let sample = null;
    if (!ok) {
        const ks = Object.keys(linguist ?? {});
        const sampleKey = ks[0];
        const sampleVal = sampleKey ? linguist[sampleKey] : undefined;
        sample = { sampleKey, sampleVal };
    }

    return { ok, keys, bytesSum, topPreview, sample };
}

function toTopLangs(langBytes, n) {
    const entries = [...langBytes.entries()].sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, b]) => s + b, 0);
    if (total <= 0) return [];

    return entries.slice(0, n).map(([lang, bytes]) => ({
        lang,
        bytes,
        pct: bytes / total,
    }));
}

/* ------------------------- GitHub GraphQL ------------------------- */

async function ghGraphql(token, query, variables) {
    const res = await fetchWithRetry(
        "https://api.github.com/graphql",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ query, variables }),
        },
        { tries: 4, baseDelayMs: 700 }
    );

    const json = await res.json();
    if (json.errors?.length) {
        const err = new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
        err._graphqlErrors = json.errors;
        throw err;
    }
    return json.data;
}

/**
 * Robust contributionsCollection:
 * - Some schemas don't accept includePrivateContributions arg (your error).
 * - So: try with it; if "argumentNotAccepted", fallback without it.
 */
async function getContribRobust(user, token) {
    // Try 1 (with includePrivateContributions)
    const queryWith = `
    query($login: String!, $includePrivate: Boolean!) {
      user(login: $login) {
        contributionsCollection(includePrivateContributions: $includePrivate) {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalRepositoryContributions
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays { date contributionCount }
            }
          }
        }
      }
    }
  `;

    try {
        const data = await ghGraphql(token, queryWith, { login: user, includePrivate: true });
        return normalizeContrib(data.user.contributionsCollection);
    } catch (e) {
        const errs = e?._graphqlErrors;
        const argNotAccepted =
            Array.isArray(errs) &&
            errs.some((x) => x?.extensions?.code === "argumentNotAccepted" && x?.extensions?.argumentName === "includePrivateContributions");
        if (!argNotAccepted) throw e;

        console.warn("[WARN] contributionsCollection(includePrivateContributions) not supported. fallback without it.");
    }

    // Fallback (no arg)
    const queryNo = `
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
              contributionDays { date contributionCount }
            }
          }
        }
      }
    }
  `;
    const data2 = await ghGraphql(token, queryNo, { login: user });
    return normalizeContrib(data2.user.contributionsCollection);
}

function normalizeContrib(cc) {
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
            total: cc.contributionCalendar.totalContributions,
        },
        calendarByDate,
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
            total: a.stats.total + b.stats.total,
        },
        calendarByDate,
    };
}

/* ------------------------- README rendering ------------------------- */

function buildMarkdownBlock({ generatedAt, users, excludeOrgs, allowForkRepos, repoCount, topLangs, assets, stats }) {
    const excludeLine = excludeOrgs.length ? excludeOrgs.map((s) => `\`${s}\``).join(", ") : "(none)";
    const allowForkLine = allowForkRepos.length ? allowForkRepos.map((s) => `\`${s}\``).join(", ") : "(none)";

    // NOTE: GitHub README inline <svg> is *sometimes* unstable (sanitization / rendering edge),
    // so we embed via <img src="assets/...svg"> (must commit assets).
    const statsImg = `<img src="${assets.statsPath}" alt="Profile stats" />`;
    const langsImg = `<img src="${assets.langsPath}" alt="Languages" />`;
    const heatImg = `<img src="${assets.heatPath}" alt="Activity heatmap" />`;

    const langLines =
        topLangs.length === 0
            ? "- (no language data)\n"
            : topLangs
                .map((x) => `- ${x.lang}: ${(x.pct * 100).toFixed(1)}% (${formatBytes(x.bytes)})`)
                .join("\n");

    return [
        `${README_MARKER_START}`,
        ``,
        `## 🧠 PR Diff Languages (All time, Linguist-based)`,
        ``,
        statsImg,
        ``,
        `### Repo filters`,
        ``,
        `- users: ${users.personal} + ${users.work}`,
        `- exclude forks: yes (except allowlist)`,
        `- fork allowlist: ${allowForkLine}`,
        `- exclude archived: yes`,
        `- exclude orgs: ${excludeLine}`,
        `- repos: ${repoCount.before} -> ${repoCount.after} (cloned: ${repoCount.cloned})`,
        ``,
        `### Languages (Linguist, aggregated from cloned repos)`,
        ``,
        langsImg,
        ``,
        `<details><summary>raw breakdown</summary>`,
        ``,
        langLines,
        ``,
        `</details>`,
        ``,
        `### Activity (merged heatmap)`,
        ``,
        heatImg,
        ``,
        `updated: \`${generatedAt}\``,
        ``,
        `${README_MARKER_END}`,
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

/* ------------------------- SVG: stats cards ------------------------- */

function buildStatsCardsSvg({ users, stats, repoCount }) {
    const w = 740;
    const pad = 18;
    const gap = 12;

    const cardW = Math.floor((w - pad * 2 - gap) / 2);
    const cardH = 84;
    const h = pad * 2 + cardH * 2 + gap;

    const bg = "#0d1117";
    const stroke = "#30363d";
    const text = "#c9d1d9";
    const sub = "#8b949e";

    const items = [
        { title: "Users", value: `${users.personal} + ${users.work}`, sub: "merged accounts" },
        { title: "Contributions", value: fmtInt(stats.total), sub: "last ~1y (calendar)" },
        { title: "PR / Issue", value: `${fmtInt(stats.prs)} / ${fmtInt(stats.issues)}`, sub: "contributionsCollection" },
        { title: "Commit / Repo", value: `${fmtInt(stats.commits)} / ${fmtInt(stats.repos)}`, sub: `repos cloned: ${repoCount.cloned}` },
    ];

    const card = (x, y, { title, value, subline }) => {
        return `
<g>
  <rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="12" ry="12" fill="${bg}" stroke="${stroke}"/>
  <text x="${x + 14}" y="${y + 28}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" font-size="13" fill="${sub}">${escapeXml(
            title
        )}</text>
  <text x="${x + 14}" y="${y + 56}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" font-size="22" font-weight="700" fill="${text}">${escapeXml(
            value
        )}</text>
  <text x="${x + 14}" y="${y + 74}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" font-size="12" fill="${sub}">${escapeXml(
            subline
        )}</text>
</g>`;
    };

    const [a, b, c, d] = items.map((x) => ({
        title: x.title,
        value: x.value,
        subline: x.sub,
    }));

    const x1 = pad;
    const x2 = pad + cardW + gap;
    const y1 = pad;
    const y2 = pad + cardH + gap;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
${card(x1, y1, a)}
${card(x2, y1, b)}
${card(x1, y2, c)}
${card(x2, y2, d)}
</svg>`;
}

/* ------------------------- SVG: language bars ------------------------- */

function buildLangBarsSvg({ title, items, note }) {
    const w = 900;
    const pad = 18;

    const text = "#c9d1d9";
    const sub = "#8b949e";
    const stroke = "#30363d";

    const headerH = 70;
    const rowH = 34;
    const barH = 18;

    const n = Math.min(items.length, LANG_TOP_N);
    const h = pad * 2 + headerH + n * rowH + 12;

    const barX = pad + 260;
    const barW = w - barX - pad;

    const bg = "#0d1117";
    const panel = "#161b22";

    // If empty, still output stable frame
    const safeMaxPct = Math.max(...items.slice(0, n).map((x) => x.pct), 0.000001);

    // Mask for rounded bar
    const maskId = `mask_${Math.random().toString(16).slice(2)}`;

    let bars = "";
    if (n > 0) {
        for (let i = 0; i < n; i++) {
            const it = items[i];
            const y = pad + headerH + i * rowH;

            const width = Math.max(2, Math.round(barW * (it.pct / safeMaxPct)));
            const color = `hsl(${hashToHue(it.lang)}, 70%, 55%)`;

            bars += `
<g>
  <text x="${pad}" y="${y + 14}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" font-size="13" fill="${text}">${escapeXml(
                it.lang
            )}</text>
  <text x="${pad}" y="${y + 30}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" font-size="12" fill="${sub}">${(it.pct * 100).toFixed(
                1
            )}% · ${escapeXml(formatBytes(it.bytes))}</text>

  <rect x="${barX}" y="${y + 8}" width="${barW}" height="${barH}" rx="9" ry="9" fill="#0b1320" stroke="${stroke}" />
  <rect x="${barX}" y="${y + 8}" width="${width}" height="${barH}" rx="9" ry="9" fill="${color}">
    <title>${escapeXml(`${it.lang}: ${(it.pct * 100).toFixed(1)}% (${formatBytes(it.bytes)})`)}</title>
  </rect>
</g>`;
        }
    }

    // Stable SVG frame (even if bars empty)
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <mask id="${maskId}">
      <rect x="${pad}" y="${pad + headerH - 20}" width="${w - pad * 2}" height="9999" fill="#fff"/>
    </mask>
  </defs>

  <rect x="0" y="0" width="${w}" height="${h}" rx="16" ry="16" fill="${bg}" />
  <rect x="${pad}" y="${pad}" width="${w - pad * 2}" height="${h - pad * 2}" rx="12" ry="12" fill="${panel}" stroke="${stroke}" />

  <text x="${pad + 18}" y="${pad + 30}" fill="${text}" font-size="18" font-weight="700"
    font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial">${escapeXml(title)}</text>

  <text x="${pad + 18}" y="${pad + 52}" fill="${sub}" font-size="12"
    font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial">${escapeXml(note ?? "")}</text>

  <g mask="url(#${maskId})">
    ${bars}
  </g>

  ${
        n === 0
            ? `<text x="${pad + 18}" y="${pad + headerH + 30}" fill="${sub}" font-size="12"
  font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial">No language data (linguist returned empty)</text>`
            : ""
    }
</svg>`;
}

/* ------------------------- SVG: heatmap ------------------------- */

function buildHeatmapSvg(calendarByDate) {
    const dates = [...calendarByDate.keys()].sort();
    if (dates.length === 0) {
        // stable empty svg
        return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="740" height="140" viewBox="0 0 740 140">
  <rect x="0" y="0" width="740" height="140" rx="16" ry="16" fill="#0d1117"/>
  <text x="20" y="70" fill="#8b949e" font-size="14" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto">no data</text>
</svg>`;
    }

    const max = Math.max(...dates.map((d) => calendarByDate.get(d) ?? 0));
    const levelOf = (c) => {
        if (c <= 0) return 0;
        if (max <= 0) return 1;
        const lvl = Math.ceil((c / max) * 4);
        return Math.min(4, Math.max(1, lvl));
    };

    const colors = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"];

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
    const pad = 18;
    const gridW = 53 * (cell + gap);
    const gridH = 7 * (cell + gap);

    const w = pad * 2 + gridW + 20;
    const h = pad * 2 + gridH + 20;

    let rects = "";
    for (let idx = 0; idx < cells.length; idx++) {
        const col = Math.floor(idx / 7);
        const row = idx % 7;
        const x = pad + 10 + col * (cell + gap);
        const y = pad + 10 + row * (cell + gap);
        const fill = colors[cells[idx].level];
        rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${fill}"><title>${escapeXml(
            `${cells[idx].key}: ${cells[idx].c}`
        )}</title></rect>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="0" y="0" width="${w}" height="${h}" rx="16" ry="16" fill="#0d1117"/>
  <rect x="${pad}" y="${pad}" width="${w - pad * 2}" height="${h - pad * 2}" rx="12" ry="12" fill="#0b1320" stroke="#30363d"/>
  ${rects}
</svg>`;
}

/* ------------------------- utils ------------------------- */

function hashToHue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
}

function fmtInt(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "0";
    return Math.round(x).toLocaleString("en-US");
}

function formatBytes(n) {
    const units = ["B", "KB", "MB", "GB"];
    let x = Number(n);
    if (!Number.isFinite(x) || x < 0) x = 0;

    let i = 0;
    while (x >= 1024 && i < units.length - 1) {
        x /= 1024;
        i++;
    }
    return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function escapeXml(s) {
    return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

/* ------------------------- run ------------------------- */

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
