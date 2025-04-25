import { Octokit } from "@octokit/action";
import { readFileSync } from "fs";

const compilation_output = readFileSync("compilation.log").toString;

console.log("Parsed compilation output:", compilation_output);

// if the action is triggered by not a pull request, exit
if (!process.env.GITHUB_REF?.startsWith("refs/pull/")) {
  console.log("Not a pull request, exiting.");
  process.exit(0);
}

const octokit = new Octokit();

const [owner, repo] = process.env.GITHUB_REPOSITORY?.split("/")!;
const pull_request_number = parseInt(process.env.GITHUB_REF?.split("/")[2]!);

octokit.rest.issues.createComment({
  owner,
  repo,
  issue_number: pull_request_number,
  body: `compilation output is: \n\n\`\`\`\n${compilation_output}\n\`\`\``,
});
