import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";

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

const runId = parseInt(requireEnv("INPUT_RUN_ID"));
const jobId = parseInt(requireEnv("INPUT_JOB_ID"));

const [owner, repo] = githubRepository.split("/");
const pullRequestNumber = parseInt(githubRef.split("/")[2]);

const ignoreNoMarker = requireEnv("INPUT_IGNORE_NO_MARKER") === "true";

const jobRegex = requireEnv("INPUT_JOB_REGEX");
const stepRegex = requireEnv("INPUT_STEP_REGEX");

const workerUrl = requireEnv("INPUT_WORKER_URL");

// ── Authentication ──────────────────────────────────────────────────────────
// Exchange a GitHub OIDC token for an installation access token via the
// Cloudflare Worker. Requires id-token: write on the job.

const installationToken = await getInstallationTokenFromWorker(workerUrl);
const octokit = new Octokit({ auth: installationToken });
const gql = graphql.defaults({ headers: { authorization: `token ${installationToken}` } });

// ── Job log processing ──────────────────────────────────────────────────────

interface Row {
  url: string;
  status: string;
  [field: string]: string;
}

const warningRegex = /warning( .\d+)?:/;
const errorRegex = /error( .\d+)?:/;

const rows: Row[] = [];

const { data: jobList } = await octokit.actions.listJobsForWorkflowRun({
  owner,
  repo,
  run_id: runId,
  per_page: 100,
});

for (const job of jobList.jobs) {
  if (job.id === jobId) continue;

  const { url: redirectUrl } = await octokit.actions.downloadJobLogsForWorkflowRun({
    owner,
    repo,
    job_id: job.id,
  });

  const response = await fetch(redirectUrl);
  if (!response.ok) {
    console.log(`failed to retrieve job log for ${job.id}`);
    continue;
  }
  const jobLog = await response.text();

  const lines = jobLog.split("\n");
  console.log(`total lines: ${lines.length}`);

  let offset = 0;
  const offsetIdx = lines.findIndex((line) => line.match("CPPWARNINGNOTIFIER_LOG_MARKER"));
  if (offsetIdx !== -1) {
    offset = offsetIdx;
  } else {
    if (ignoreNoMarker) {
      continue;
    }
  }

  let compileResult = "✅success";
  let firstIssueLine = 1;
  const warningIdx = lines.findIndex((line) => line.match(warningRegex));
  console.log(`warningIdx: ${warningIdx}`);
  if (warningIdx !== -1) {
    compileResult = "⚠️warning";
    firstIssueLine = warningIdx - offset + 1;
    console.log(`matched warning line: ${lines[warningIdx]}`);
  } else {
    const errorIdx = lines.findIndex((line) => line.match(errorRegex));
    console.log(`errorIdx: ${errorIdx}`);
    if (errorIdx !== -1) {
      compileResult = "❌error";
      firstIssueLine = errorIdx - offset + 1;
      console.log(`matched error line: ${lines[errorIdx]}`);
    }
  }

  const steps = job.steps ?? [];
  const stepIndex = steps.findIndex(
    (step) =>
      step.name.match(stepRegex) &&
      step.status === "completed" &&
      step.conclusion === "success",
  );
  const stepId = (stepIndex === -1 ? steps.length : stepIndex) + 1;

  console.log(`stepId is ${stepId}`);
  console.log(`job name is "${job.name}"`);

  const jobMatch = job.name.match(jobRegex);

  if (!jobMatch) {
    console.log("job match fail");
    continue;
  }

  rows.push({
    url: `https://github.com/${owner}/${repo}/actions/runs/${runId}/job/${job.id}#step:${stepId}:${firstIssueLine}`,
    status: compileResult,
    ...jobMatch.groups,
  });
}

console.log("rows", rows);

const rowHeaderFields: string[] = JSON.parse(requireEnv("INPUT_ROW_HEADERS"));
const columnField = requireEnv("INPUT_COLUMN_HEADER");

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
  if (depth === rowHeaderFields.length) {
    const representative = rows[0];
    const rowFields = rowHeaderFields.map((f) => representative[f]);
    const tds = columns.map((col) => {
      const cell = cellMap.get(JSON.stringify([...rowFields, col]));
      if (!cell) return "<td></td>";
      return `<td><a href="${escapeHtml(cell.url)}">${escapeHtml(cell.status)}</a></td>`;
    });
    return [`${tds.join("")}</tr>`];
  }

  const field = rowHeaderFields[depth];
  const groups = Map.groupBy(rows, (r) => r[field] ?? "");
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

function generateTable(entries: Row[]): string {
  const columns = [...new Set(entries.map((e) => e[columnField] ?? ""))].sort(
    (a, b) => Number(a) - Number(b),
  );

  const sorted = [...entries].sort((a, b) => {
    for (const field of rowHeaderFields) {
      const av = a[field] ?? "";
      const bv = b[field] ?? "";
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });

  const cellMap = new Map<string, Row>();
  for (const entry of sorted) {
    const key = JSON.stringify([...rowHeaderFields.map((f) => entry[f]), entry[columnField]]);
    cellMap.set(key, entry);
  }

  const theadCols = columns.map((v) => `<th>C++${v}</th>`).join("");
  const thead = `<thead><tr><th colspan="${rowHeaderFields.length}">Environment</th>${theadCols}</tr></thead>`;

  const rows = renderRows(sorted, 0, columns, cellMap);
  const tbody = `<tbody>${rows.map((r) => `<tr>${r}`).join("")}</tbody>`;

  return `<table>${thead}${tbody}</table>`;
}

const body = generateTable(rows);

console.log("body is", body);

if (body) {
  console.log("outdates previous comments");
  const { data: comments } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: pullRequestNumber,
  });

  const postComment = async () => {
    console.log("leaving comment");
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullRequestNumber,
      body,
    });
  };

  const sortedComments = comments
    .filter((comment) => comment.user?.login === "cppwarningnotifier[bot]")
    .toSorted((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  if (sortedComments.length > 0) {
    const latestComment = sortedComments[sortedComments.length - 1];

    if (body.includes("warning") || latestComment.body?.includes("warning")) {
      await gql(
        `mutation MinimizeComment($id: ID!) {
          minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
            clientMutationId
          }
        }`,
        { id: latestComment.node_id },
      );

      await postComment();
    }
  } else {
    await postComment();
  }
}

// ── Worker authentication helper ────────────────────────────────────────────

async function getInstallationTokenFromWorker(workerUrl: string): Promise<string> {
  const tokenRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const tokenRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!tokenRequestUrl || !tokenRequestToken) {
    throw new Error(
      "ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN are not set. " +
        "Ensure the job has 'permissions: id-token: write'.",
    );
  }

  // Request the OIDC token with the worker URL as the audience so the worker
  // can verify the token was intended for it.
  const oidcRequestUrl = `${tokenRequestUrl}&audience=${encodeURIComponent(workerUrl)}`;
  const oidcResponse = await fetch(oidcRequestUrl, {
    headers: { Authorization: `bearer ${tokenRequestToken}` },
  });

  if (!oidcResponse.ok) {
    const text = await oidcResponse.text();
    throw new Error(`Failed to obtain GitHub OIDC token (${oidcResponse.status}): ${text}`);
  }

  const { value: oidcToken } = (await oidcResponse.json()) as { value: string };

  // Exchange the OIDC token for a GitHub App installation access token.
  const tokenResponse = await fetch(`${workerUrl}/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${oidcToken}` },
  });

  if (!tokenResponse.ok) {
    const err = (await tokenResponse.json()) as { error?: string };
    throw new Error(
      `Worker token exchange failed (${tokenResponse.status}): ${err.error ?? "unknown error"}`,
    );
  }

  const { token } = (await tokenResponse.json()) as { token: string };
  return token;
}
