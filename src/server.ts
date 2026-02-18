import { App, createNodeMiddleware } from "octokit";
import { createServer } from "node:http";
import { collect_rows, generate_table, post_or_update_comment, type Config } from "./core.js";

function require_env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const app = new App({
  appId: require_env("APP_ID"),
  privateKey: require_env("APP_PRIVATE_KEY"),
  webhooks: { secret: require_env("WEBHOOK_SECRET") },
});

async function read_repo_config(
  octokit: InstanceType<typeof App>["octokit"],
  owner: string,
  repo: string,
): Promise<Config | null> {
  try {
    const { data } = await (octokit as any).rest.repos.getContent({
      owner,
      repo,
      path: ".github/cpp-warning-notifier.json",
    });
    if (!("content" in data)) return null;
    const json = JSON.parse(Buffer.from(data.content, "base64").toString());
    return {
      job_regex: json.job_regex,
      step_regex: json.step_regex,
      row_headers: json.row_headers,
      column_header: json.column_header,
      ignore_no_marker: json.ignore_no_marker ?? false,
    };
  } catch {
    return null;
  }
}

app.webhooks.on("workflow_run.completed", async ({ octokit, payload }) => {
  const { repository, workflow_run } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const run_id = workflow_run.id;

  const pull_requests = workflow_run.pull_requests;
  if (pull_requests.length === 0) {
    console.log(`run ${run_id}: no associated pull requests, skipping`);
    return;
  }

  const config = await read_repo_config(octokit, owner, repo);
  if (!config) {
    console.log(`${owner}/${repo}: no .github/cpp-warning-notifier.json, skipping`);
    return;
  }

  for (const pr of pull_requests) {
    console.log(`processing run ${run_id} for PR #${pr.number} in ${owner}/${repo}`);

    const rows = await collect_rows(octokit as any, owner, repo, run_id, config);
    const body = generate_table(rows, config);

    console.log("body is", body);

    if (body) {
      const { data: app_info } = await octokit.rest.apps.getAuthenticated();
      const bot_login = `${app_info.slug}[bot]`;
      await post_or_update_comment(octokit as any, owner, repo, pr.number, body, bot_login);
    }
  }
});

const port = parseInt(process.env.PORT ?? "3000");
const middleware = createNodeMiddleware(app);

createServer(middleware).listen(port, () => {
  console.log(`webhook server listening on port ${port}`);
});
