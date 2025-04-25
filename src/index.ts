import { Octokit } from "@octokit/action";
import { readFileSync } from "fs";

import parser, { type OutputEntry } from "gcc-output-parser";

const compilation_output = readFileSync("compilation.log");
const outputs = parser.parseString(compilation_output);

let error_or_warnings: Array<{
  error_or_warning: OutputEntry;
  notes: Array<OutputEntry>;
}> = [];

let cursor = 0;
while (cursor < outputs.length) {
  if (outputs[cursor].type === "error" || outputs[cursor].type === "warning") {
    let notes_cursor = cursor + 1;
    while (
      notes_cursor < outputs.length &&
      outputs[notes_cursor].type === "note"
    ) {
      notes_cursor++;
    }
    const error_or_warning = outputs[cursor];
    const notes = outputs.slice(cursor + 1, notes_cursor);

    error_or_warnings.push({
      error_or_warning,
      notes,
    });

    cursor = notes_cursor;
  } else {
    cursor++;
  }
}

console.log("Parsed compilation output:", error_or_warnings);

// if the action is triggered by not a pull request, exit
if (!process.env.GITHUB_REF?.startsWith("refs/pull/")) {
  console.log("Not a pull request, exiting.");
  process.exit(0);
}

if (error_or_warnings.length === 0) {
  console.log("No errors or warnings, exiting.");
  process.exit(0);
}

let body = JSON.stringify(error_or_warnings, null, "  ");

const octokit = new Octokit();

const [owner, repo] = process.env.GITHUB_REPOSITORY?.split("/")!;
const pull_request_number = parseInt(process.env.GITHUB_REF?.split("/")[2]!);

octokit.rest.issues.createComment({
  owner,
  repo,
  issue_number: pull_request_number,
  body: `compilation output is: \n\n\`\`\`\n${body}\n\`\`\``,
});
