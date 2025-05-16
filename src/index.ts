import { readdirSync, readFileSync } from "fs";
import { App } from "octokit";

if (!process.env.GITHUB_REF?.startsWith("refs/pull/")) {
  console.log("not a pull request, exiting.");
  process.exit(0);
}

const appId = parseInt(process.env.INPUT_APP_ID!);
const privateKey = process.env.INPUT_PRIVATE_KEY!;
const installationId = parseInt(process.env.INPUT_INSTALLATION_ID!);
const clientId = process.env.INPUT_CLIENT_ID!;
const clientSecret = process.env.INPUT_CLIENT_SECRET!;

const app = new App({ appId, privateKey, oauth: { clientId, clientSecret } });
const octokit = await app.getInstallationOctokit(installationId);

const [owner, repo] = process.env.GITHUB_REPOSITORY?.split("/")!;
const pull_request_number = parseInt(process.env.GITHUB_REF?.split("/")[2]!);

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

let matrix: any = {};

for (const file of readdirRecursively(".")) {
  console.log("looking", file, "deciding whether skip or not...");

  const artifactMatch = file.match(/compilation_(\d+)_(\d+)_(\d+)_log/);

  if (artifactMatch === null || artifactMatch.length === 0) {
    continue;
  }

  const runId = artifactMatch[1];
  const jobId = artifactMatch[2];
  // const stepId = artifactMatch[3];

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
      console.log(i, step);
      if (
        step.name.toLowerCase().match(/build( \(.+\))?/) &&
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

  // build (ubuntu, 24.04, Release, 20, 1.86.0, GNU, 13, g++-13)
  const jobMatch = job.name.match(/.+\((.+?)\)/);
  if (!jobMatch || jobMatch.length === 0) {
    console.log("job match fail");
    continue;
  }

  const info = jobMatch[1].split(", ");

  console.log("info: ", info);

  const osName = info[0];
  const osVersion = info[1];
  const buildType = info[2];
  const cppVersion = info[3];
  // const boostVersion = info[4];
  const compilerName = info[5];
  const compilerVersion = info[6];
  // const compilerExecutable = info[7];

  const url = `https://github.com/${owner}/${repo}/actions/runs/${runId}/job/${jobId}#step:${stepId}:1`;

  matrix[osName + osVersion] ??= {};
  matrix[osName + osVersion][compilerName] ??= {};
  matrix[osName + osVersion][compilerName][compilerVersion] ??= {};
  matrix[osName + osVersion][compilerName][compilerVersion][buildType] ??= [];
  matrix[osName + osVersion][compilerName][compilerVersion][buildType][
    (parseInt(cppVersion) - 23) / 3
  ] ??= `<a href="${url}">${compileResult}</a>`;

  // const appendString = `1. [${job.name}](<${url}>)\n`;
  // if (body) {
  //   body += appendString;
  // } else {
  //   body = appendString;
  // }
}

console.log(matrix);

type NestedData = {
  [keys: string]: NestedData | string[];
};

function generateTable(data: NestedData): string {
  return `
  <table>
    <thead>
      <th colspan=4>Environment</th>
      <th>C++23</th>
      <th>C++26</th>
    </thead>
    <tbody>
    ${generateRows(data)}
    </tbody>
  </table>
  `;
}

function generateRows(data: NestedData): string {
  function count(obj: NestedData) {
    let res = 0;
    for (const [_, val] of Object.entries(obj)) {
      if (Array.isArray(val)) ++res;
      else res += count(val);
    }
    return res;
  }

  function traverse(obj: NestedData, body: string = "<tr>") {
    for (const [key, val] of Object.entries(obj).toSorted()) {
      if (Array.isArray(val)) {
        body += `<th>${key}</th>`;
        for (let i = 0; i < 2; ++i) {
          if (val[i]) body += `<td>${val[i]}</td>`;
          else body += `<td></td>`;
        }
        body += "</tr><tr>";
      } else {
        body += `<th rowspan="${count(val)}">${key}</th>`;
        body = traverse(val, body);
      }
    }
    return body;
  }
  let res = traverse(data);
  return res.substring(0, res.length - "</tr><tr>".length); // remove trailing <tr></tr>
}

body ??= generateTable(matrix);

console.log("body is", body);

if (body) {
  console.log("outdates previous comments");
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pull_request_number,
  });
  const sorted_comments = comments
    .filter((comment) => comment.user?.login == "cppwarningnotifier[bot]")
    .toSorted(
      (a, b) =>
        new Date(a.created_at).getSeconds() -
        new Date(b.created_at).getSeconds()
    );
  const latest_comment = sorted_comments[sorted_comments.length - 1];
  await octokit.graphql(`
        mutation {
          minimizeComment(input: { subjectId: "${latest_comment.node_id}", classifier: OUTDATED }) {
            clientMutationId
          }
        }
      `);

  console.log("leaving comment");
  octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pull_request_number,
    body,
  });
}
