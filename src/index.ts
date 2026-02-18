import { readdirSync, readFileSync } from "fs";
import { App } from "octokit";

if (!process.env.GITHUB_REF?.startsWith("refs/pull/")) {
  console.log("not a pull request, exiting.");
  process.exit(0);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const githubRepository = requireEnv("GITHUB_REPOSITORY");
const githubRef = requireEnv("GITHUB_REF");

const [owner, repo] = githubRepository.split("/");
const pull_request_number = parseInt(githubRef.split("/")[2]);

const artifact_regex = requireEnv("INPUT_ARTIFACT_REGEX");
const job_regex = requireEnv("INPUT_JOB_REGEX");
const step_regex = requireEnv("INPUT_STEP_REGEX");

const appId = 1230093;
const privateKey = requireEnv("INPUT_PRIVATE_KEY");

const app = new App({ appId, privateKey });
const { data: installation } = await app.octokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
const octokit = await app.getInstallationOctokit(installation.id);

let body: string | null = null;

const readdirRecursively = (dir: string): string[] => {
  const files: string[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${dirent.name}`;
    if (dirent.isDirectory()) files.push(...readdirRecursively(path));
    else if (dirent.isFile()) files.push(path);
  }
  return files;
};

interface Row {
  url: string;
  status: string;
  [field: string]: string;
}

const rows: Row[] = [];

for (const file of readdirRecursively(".")) {
  console.log("looking", file, "deciding whether skip or not...");

  const artifactMatch = file.match(artifact_regex);

  if (artifactMatch === null) {
    continue;
  }

  if (!artifactMatch.groups?.runId || !artifactMatch.groups?.jobId) {
    console.log("artifact regex matched but missing runId/jobId named groups, skipping", file);
    continue;
  }
  const { runId, jobId } = artifactMatch.groups;

  console.log("found", file, "detecting warnings...");

  const compilationOutput = readFileSync(file).toString();

  const warningRegex = /warning( .\d+)?:/;
  const errorRegex = /error( .\d+)?:/;

  let compileResult = "✅success";
  let firstIssueLine = 1;
  const lines = compilationOutput.split("\n");
  console.log(`total lines: ${lines.length}`);
  const warningIdx = lines.findIndex((line) => line.match(warningRegex));
  console.log(`warningIdx: ${warningIdx}`);
  if (warningIdx !== -1) {
    compileResult = "⚠️warning";
    firstIssueLine = warningIdx + 1;
    console.log(`matched warning line: ${lines[warningIdx]}`);
  } else {
    const errorIdx = lines.findIndex((line) => line.match(errorRegex));
    console.log(`errorIdx: ${errorIdx}`);
    if (errorIdx !== -1) {
      compileResult = "❌error";
      firstIssueLine = errorIdx + 1;
      console.log(`matched error line: ${lines[errorIdx]}`);
    }
  }
  // GitHub Actions step logs have a few preamble lines before the actual output
  const GITHUB_ACTIONS_LOG_OFFSET = 3;
  firstIssueLine += GITHUB_ACTIONS_LOG_OFFSET;
  console.log(`compileResult: ${compileResult}, firstIssueLine: ${firstIssueLine} (includes offset ${GITHUB_ACTIONS_LOG_OFFSET})`);

  const { data: job } = await octokit.rest.actions.getJobForWorkflowRun({
    owner,
    repo,
    job_id: parseInt(jobId),
  });

  const steps = job.steps ?? [];
  const stepIndex = steps.findIndex(
    (step) =>
      step.name.match(step_regex) &&
      step.status === "completed" &&
      step.conclusion === "success",
  );
  const stepId = (stepIndex === -1 ? steps.length : stepIndex) + 1;

  console.log(`stepId is ${stepId}`);

  console.log(`job name is "${job.name}"`);

  const jobMatch = job.name.match(job_regex);

  if (!jobMatch) {
    console.log("job match fail");
    continue;
  }

  rows.push({
    url: `https://github.com/${owner}/${repo}/actions/runs/${runId}/job/${jobId}#step:${stepId}:${firstIssueLine}`,
    status: compileResult,
    ...jobMatch.groups,
  });
}

console.log("rows", rows);

const ROW_HEADER_FIELDS: string[] = JSON.parse(requireEnv("INPUT_ROW_HEADERS"));
const COLUMN_FIELD = requireEnv("INPUT_COLUMN_HEADER");

class CompositeKeyMap<V> {
  private map = new Map<string, V>();

  get(keys: readonly string[]): V | undefined {
    return this.map.get(JSON.stringify(keys));
  }

  set(keys: readonly string[], value: V): void {
    this.map.set(JSON.stringify(keys), value);
  }
}

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
  cellMap: CompositeKeyMap<Row>,
): string[] {
  if (depth === ROW_HEADER_FIELDS.length) {
    const representative = rows[0];
    const rowFields = ROW_HEADER_FIELDS.map((f) => representative[f]);
    const tds = columns.map((col) => {
      const cell = cellMap.get([...rowFields, col]);
      if (!cell) return "<td></td>";
      return `<td><a href="${escapeHtml(cell.url)}">${escapeHtml(cell.status)}</a></td>`;
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

  const cellMap = new CompositeKeyMap<Row>();
  for (const entry of sorted) {
    const key = [...ROW_HEADER_FIELDS.map((f) => entry[f]), entry[COLUMN_FIELD]];
    cellMap.set(key, entry);
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

  const compareDate = (a: Date, b: Date) => a.getTime() - b.getTime();

  const post_comment = async () => {
    console.log("leaving comment");
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pull_request_number,
      body,
    });
  };

  const sorted_comments = comments
    .filter((comment) => comment.user?.login === "cppwarningnotifier[bot]")
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

      await post_comment();
    }
  } else {
    await post_comment();
  }
}
