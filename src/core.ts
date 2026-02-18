import type { Octokit } from "octokit";

export interface Row {
  url: string;
  status: string;
  [field: string]: string;
}

export interface Config {
  job_regex: string;
  step_regex: string;
  row_headers: string[];
  column_header: string;
  ignore_no_marker: boolean;
}

const warning_regex = /warning( .\d+)?:/;
const error_regex = /error( .\d+)?:/;

function find_first_issue(
  lines: string[],
  regex: RegExp,
  label: string,
): { index: number; label: string } | null {
  const index = lines.findIndex((line) => line.match(regex));
  if (index === -1) return null;
  console.log(`${label} index: ${index}, matched line: ${lines[index]}`);
  return { index, label };
}

export async function collect_rows(
  octokit: Octokit,
  owner: string,
  repo: string,
  run_id: number,
  config: Config,
  exclude_job_id?: number,
): Promise<Row[]> {
  const rows: Row[] = [];

  const { data: job_list } = await octokit.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id,
    per_page: 100,
  });

  for (const job of job_list.jobs) {
    const job_id = job.id;

    if (exclude_job_id !== undefined && job_id === exclude_job_id) continue;

    const { url: redirect_url } = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id,
    });

    const response = await fetch(redirect_url);
    if (!response.ok) {
      console.log(`failed to retrieve job log for ${job_id}`);
      continue;
    }
    const job_log = await response.text();

    const lines = job_log.split("\n");
    console.log(`total lines: ${lines.length}`);

    let offset = 0;
    const offset_idx = lines.findIndex((line) => line.match("CPPWARNINGNOTIFIER_LOG_MARKER"));
    if (offset_idx !== -1) {
      offset = offset_idx;
    } else {
      if (config.ignore_no_marker) {
        continue;
      }
    }

    let compile_result = "✅success";
    let first_issue_line = 1;

    const issue =
      find_first_issue(lines, warning_regex, "warning") ??
      find_first_issue(lines, error_regex, "error");

    if (issue) {
      compile_result = issue.label === "warning" ? "⚠️warning" : "❌error";
      first_issue_line = issue.index - offset + 1;
    }

    const steps = job.steps ?? [];
    const step_index = steps.findIndex(
      (step) =>
        step.name.match(config.step_regex) &&
        step.status === "completed" &&
        step.conclusion === "success",
    );
    const step_id = (step_index === -1 ? steps.length : step_index) + 1;

    console.log(`step_id is ${step_id}`);
    console.log(`job name is "${job.name}"`);

    const job_match = job.name.match(config.job_regex);

    if (!job_match) {
      console.log("job match fail");
      continue;
    }

    rows.push({
      url: `https://github.com/${owner}/${repo}/actions/runs/${run_id}/job/${job_id}#step:${step_id}:${first_issue_line}`,
      status: compile_result,
      ...job_match.groups,
    });
  }

  console.log("rows", rows);
  return rows;
}

class CompositeKeyMap<V> {
  private map = new Map<string, V>();

  get(keys: readonly string[]): V | undefined {
    return this.map.get(JSON.stringify(keys));
  }

  set(keys: readonly string[], value: V): void {
    this.map.set(JSON.stringify(keys), value);
  }
}

function escape_html(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function render_rows(
  rows: Row[],
  depth: number,
  columns: string[],
  cell_map: CompositeKeyMap<Row>,
  row_header_fields: string[],
): string[] {
  if (depth === row_header_fields.length) {
    const representative = rows[0];
    const row_fields = row_header_fields.map((f) => representative[f]);
    const tds = columns.map((col) => {
      const cell = cell_map.get([...row_fields, col]);
      if (!cell) return "<td></td>";
      return `<td><a href="${escape_html(cell.url)}">${escape_html(cell.status)}</a></td>`;
    });
    return [`${tds.join("")}</tr>`];
  }

  const field = row_header_fields[depth];
  const groups = Object.entries(Object.groupBy(rows, (r) => r[field] ?? ""));
  const result: string[] = [];

  for (const [value, group] of groups) {
    const child_rows = render_rows(group!, depth + 1, columns, cell_map, row_header_fields);
    const rowspan = child_rows.length;
    const th =
      rowspan > 1
        ? `<th rowspan="${rowspan}">${escape_html(value)}</th>`
        : `<th>${escape_html(value)}</th>`;

    child_rows[0] = `${th}${child_rows[0]}`;
    result.push(...child_rows);
  }

  return result;
}

export function generate_table(entries: Row[], config: Config): string {
  const row_header_fields = config.row_headers;
  const column_field = config.column_header;

  const columns = [...new Set(entries.map((e) => e[column_field] ?? ""))].sort(
    (a, b) => Number(a) - Number(b),
  );

  const sorted = [...entries].sort((a, b) => {
    for (const field of row_header_fields) {
      const av = a[field] ?? "";
      const bv = b[field] ?? "";
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });

  const cell_map = new CompositeKeyMap<Row>();
  for (const entry of sorted) {
    const key = [...row_header_fields.map((f) => entry[f]), entry[column_field]];
    cell_map.set(key, entry);
  }

  const thead_cols = columns.map((v) => `<th>C++${v}</th>`).join("");
  const thead = `<thead><tr><th colspan="${row_header_fields.length}">Environment</th>${thead_cols}</tr></thead>`;

  const table_rows = render_rows(sorted, 0, columns, cell_map, row_header_fields);
  const tbody = `<tbody>${table_rows.map((r) => `<tr>${r}`).join("")}</tbody>`;

  return `<table>${thead}${tbody}</table>`;
}

export async function post_or_update_comment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_request_number: number,
  body: string,
  bot_login: string,
): Promise<void> {
  console.log("outdates previous comments");
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pull_request_number,
  });

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
    .filter((comment) => comment.user?.login === bot_login)
    .toSorted((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  if (sorted_comments.length > 0) {
    const latest_comment = sorted_comments[sorted_comments.length - 1];

    if (body.includes("warning") || latest_comment.body?.includes("warning")) {
      await octokit.graphql(
        `mutation($id: ID!) {
          minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
            clientMutationId
          }
        }`,
        { id: latest_comment.node_id },
      );

      await post_comment();
    }
  } else {
    await post_comment();
  }
}
