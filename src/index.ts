import { App } from "octokit";
import { collect_rows, generate_table, post_or_update_comment, type Config } from "./core.js";

if (!process.env.GITHUB_REF?.startsWith("refs/pull/")) {
  console.log("not a pull request, exiting.");
  process.exit(0);
}

function require_env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const github_repository = require_env("GITHUB_REPOSITORY");
const github_ref = require_env("GITHUB_REF");

const current_run_id = parseInt(require_env("INPUT_RUN_ID"));
const current_job_id = parseInt(require_env("INPUT_JOB_ID"));

const [owner, repo] = github_repository.split("/");
const pull_request_number = parseInt(github_ref.split("/")[2]);

const config: Config = {
  job_regex: require_env("INPUT_JOB_REGEX"),
  step_regex: require_env("INPUT_STEP_REGEX"),
  row_headers: JSON.parse(require_env("INPUT_ROW_HEADERS")),
  column_header: require_env("INPUT_COLUMN_HEADER"),
  ignore_no_marker: require_env("INPUT_IGNORE_NO_MARKER") === "true",
};

const app_id = 1230093;
const private_key = require_env("APP_PRIVATE_KEY");

const app = new App({ appId: app_id, privateKey: private_key });
const { data: installation } = await app.octokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
const octokit = await app.getInstallationOctokit(installation.id);

const rows = await collect_rows(octokit, owner, repo, current_run_id, config, current_job_id);
const body = generate_table(rows, config);

console.log("body is", body);

if (body) {
  await post_or_update_comment(octokit, owner, repo, pull_request_number, body, "cppwarningnotifier[bot]");
}
