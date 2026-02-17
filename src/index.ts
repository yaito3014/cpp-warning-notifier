import { readdirSync, readFileSync } from "fs";
import { App } from "octokit";

if (!process.env.GITHUB_REF?.startsWith("refs/pull/")) {
  console.log("not a pull request, exiting.");
  process.exit(0);
}

const [owner, repo] = process.env.GITHUB_REPOSITORY?.split("/")!;
const pull_request_number = parseInt(process.env.GITHUB_REF?.split("/")[2]!);

const artifact_regex = process.env.INPUT_ARTIFACT_REGEX!;
const job_regex = process.env.INPUT_JOB_REGEX!;
const step_regex = process.env.INPUT_STEP_REGEX!;

const appId = 1230093;
const privateKey = process.env.INPUT_PRIVATE_KEY!;

const app = new App({ appId, privateKey });
const { data: installation } = await app.octokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
const octokit = await app.getInstallationOctokit(installation.id);

let body: string | null = null;

const readdirRecursively = (dir: string, files: string[] = []) => {
  const dirents = readdirSync(dir, { withFileTypes: true });
  const dirs = [];
  for (const dirent of dirents) {
    if (dirent.isDirectory()) dirs.push(`${dir}/${dirent.name}`);
    if (dirent.isFile()) files.push(`${dir}/${dirent.name}`);
  }
  for (const d of dirs) {
    files = readdirRecursively(d, files);
  }
  return files;
};

type Row = Record<string, string>;

let rows: Row[] = [];

for (const file of readdirRecursively(".")) {
  console.log("looking", file, "deciding whether skip or not...");

  const artifactMatch = file.match(artifact_regex);

  if (artifactMatch === null || artifactMatch.length === 0) {
    continue;
  }

  const runId = artifactMatch.groups!.runId;
  const jobId = artifactMatch.groups!.jobId;

  console.log("found", file, "detecting warnings...");

  const compilationOutput = readFileSync(file).toString();

  const compileResult = (() => {
    const warningMatch = compilationOutput.match(/warning( .\d+)?:/);
    if (warningMatch && warningMatch.length > 0) return "⚠️warning";

    const errorMatch = compilationOutput.match(/error( .\d+)?:/);
    if (errorMatch && errorMatch.length > 0) return "❌error";

    return "✅success";
  })();

  const { data: job } = await octokit.rest.actions.getJobForWorkflowRun({
    owner,
    repo,
    job_id: parseInt(jobId),
  });

  const stepId = (() => {
    let i = 0;
    while (i < job.steps!.length) {
      const step = job.steps![i];
      // console.log(i, step);
      if (
        step.name.toLowerCase().match(step_regex) &&
        step.status === "completed" &&
        step.conclusion === "success"
      ) {
        break;
      }
      ++i;
    }
    return i + 1;
  })();

  console.log(`stepId is ${stepId}`);

  console.log(`job name is "${job.name}"`);

  const jobMatch = job.name.match(job_regex);

  if (!jobMatch || jobMatch.length === 0) {
    console.log("job match fail");
    continue;
  }

  rows.push({
    url: `https://github.com/${owner}/${repo}/actions/runs/${runId}/job/${jobId}#step:${stepId}:1`,
    ...jobMatch.groups!,
  });
}

console.log("rows", rows);

const ROW_HEADER_FIELDS: any[] = JSON.parse(process.env.INPUT_ROW_HEADERS!);
const COLUMN_FIELD = process.env.INPUT_COLUMN_HEADER!;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRows(
  rows: Row[],
  depth: number,
  columns: string[],
  cellMap: Map<string, Row>,
): string[] {
  if (depth === ROW_HEADER_FIELDS.length) {
    const representative = rows[0];
    const rowKey = JSON.stringify(ROW_HEADER_FIELDS.map((f) => representative[f]));
    const tds = columns.map((col) => {
      const cell = cellMap.get(JSON.stringify([rowKey, col]));
      if (!cell) return "<td></td>";
      return `<td><a href="${escapeHtml(cell["url"])}">${escapeHtml(cell["status"])}</a></td>`;
    });
    return [`${tds.join("")}</tr>`];
  }

  const field = ROW_HEADER_FIELDS[depth];
  const groups = groupBy(rows, (r) => r[field] ?? "");
  const result: string[] = [];

  for (const [value, group] of groups) {
    const childRows = renderRows(group, depth + 1, columns, cellMap);
    const rowspan = childRows.length;
    const th =
      rowspan > 1
        ? `<th rowspan="${rowspan}">${escapeHtml(value)}</th>`
        : `<th>${escapeHtml(value)}</th>`;

    childRows[0] = `${th}${childRows[0]}`;
    result.push(...childRows);
  }

  return result;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    let group = map.get(key);
    if (!group) {
      group = [];
      map.set(key, group);
    }
    group.push(item);
  }
  return [...map.entries()];
}

function generateTable(entries: Row[]): string {
  const columns = [...new Set(entries.map((e) => e[COLUMN_FIELD] ?? ""))].sort(
    (a, b) => Number(a) - Number(b),
  );

  const sorted = [...entries].sort((a, b) => {
    for (const field of ROW_HEADER_FIELDS) {
      const av = a[field] ?? "";
      const bv = b[field] ?? "";
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });

  const cellMap = new Map<string, Row>();
  for (const entry of sorted) {
    const rowKey = JSON.stringify(ROW_HEADER_FIELDS.map((f) => entry[f]));
    cellMap.set(JSON.stringify([rowKey, entry[COLUMN_FIELD]]), entry);
  }

  const theadCols = columns.map((v) => `<th>C++${v}</th>`).join("");
  const thead = `<thead><tr><th colspan="${ROW_HEADER_FIELDS.length}">Environment</th>${theadCols}</tr></thead>`;

  const rows = renderRows(sorted, 0, columns, cellMap);
  const tbody = `<tbody>${rows.map((r) => `<tr>${r}`).join("")}</tbody>`;

  return `<table>${thead}${tbody}</table>`;
}

body ??= generateTable(rows);

console.log("body is", body);

if (body) {
  console.log("outdates previous comments");
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pull_request_number,
  });

  const compareDate = (a: Date, b: Date) => a == b ? 0 : a < b ? -1 : 1;

  const post_comment = () => {
    console.log("leaving comment");
    octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pull_request_number,
      body,
    });
  };

  const sorted_comments = comments
    .filter((comment) => comment.user?.login == "cppwarningnotifier[bot]")
    .toSorted((a, b) => compareDate(new Date(a.created_at), new Date(b.created_at)));

  if (sorted_comments.length > 0) {
    const latest_comment = sorted_comments[sorted_comments.length - 1];

    if (body.includes("warning") || latest_comment.body?.includes("warning")) {
      // minimize latest comment
      await octokit.graphql(`
        mutation {
          minimizeComment(input: { subjectId: "${latest_comment.node_id}", classifier: OUTDATED }) {
            clientMutationId
          }
        }
      `);

      post_comment();
    }
  } else {
    post_comment();
  }
}
