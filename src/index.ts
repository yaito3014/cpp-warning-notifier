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
  const stepId = artifactMatch[3];

  console.log("found", file, "detecting warnings...");

  const compilationOutput = readFileSync(file).toString();

  const compileResult = (() => {
    const warningMatch = compilationOutput.match(/warning( .\d+)?:/);
    if (warningMatch && warningMatch.length > 0) return "warning";

    const errorMatch = compilationOutput.match(/error( .\d+)?:/);
    if (errorMatch && errorMatch.length > 0) return "error";

    return "success";
  })();

  const { data: job } = await octokit.rest.actions.getJobForWorkflowRun({
    owner,
    repo,
    job_id: parseInt(jobId),
  });

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
  const compilerVendor = info[5];
  const compilerVersion = info[6];
  // const compilerExecutable = info[7];

  const url = `https://github.com/${owner}/${repo}/actions/runs/${runId}/job/${jobId}#step:${stepId}:1`;

  matrix[osName] ??= {};
  matrix[osName][osVersion] ??= {};
  matrix[osName][osVersion][compilerVendor] ??= {};
  matrix[osName][osVersion][compilerVendor][compilerVersion] ??= {};
  matrix[osName][osVersion][compilerVendor][compilerVersion][buildType] ??= {};
  matrix[osName][osVersion][compilerVendor][compilerVersion][buildType][
    (parseInt(cppVersion) - 20) / 3
  ] ??= `[${compileResult}](<${url}>)`;

  const appendString = `1. [${job.name}](<${url}>)\n`;
  if (body) {
    body += appendString;
  } else {
    body = appendString;
  }
}

console.log(matrix);

console.log("body is", body);

if (body) {
  console.log("leaving comment");
  octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pull_request_number,
    body,
  });
}
