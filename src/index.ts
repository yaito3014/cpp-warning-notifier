import { Octokit } from "@octokit/action";
import { readFileSync } from "fs";

const compilation_output = readFileSync("compilation.log").toString();

const regex = /warning( .\d+)?:/;

const match_result = compilation_output.match(regex);

if (match_result && match_result.length > 0) {
  console.log("compilation output contains warnings.");
}

// if the action is triggered by not a pull request, exit
if (!process.env.GITHUB_REF?.startsWith("refs/pull/")) {
  console.log("not a pull request, exiting.");
  process.exit(0);
}

const octokit = new Octokit();

const [owner, repo] = process.env.GITHUB_REPOSITORY?.split("/")!;
const pull_request_number = parseInt(process.env.GITHUB_REF?.split("/")[2]!);

octokit.rest.issues.createComment({
  owner,
  repo,
  issue_number: pull_request_number,
  body: `detected warnings in the compilation output: <details><summary>compilation output</summary>\n\n\`\`\`\n${compilation_output}\n\`\`\`\n</details>`,
});
