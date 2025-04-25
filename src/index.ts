import { Octokit } from "@octokit/action";
import { readFileSync } from "fs";

const octokit = new Octokit();

const [owner, repo] = process.env.GITHUB_REPOSITORY?.split("/")!;
const pull_request_number = parseInt(process.env.GITHUB_REF?.split("/")[2]!);
const compilation_output = readFileSync("compilation.log");

octokit.rest.issues.createComment({
  owner,
  repo,
  issue_number: pull_request_number,
  body: `compilation output is:\n\n\`\`\`\n${compilation_output}\n\`\`\``,
});
