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

for (const file of readdirSync(".")) {
  if (!file.startsWith("compilation") || !file.endsWith(".log")) {
    continue;
  }

  const compilation_output = readFileSync(file).toString();

  const regex = /warning( .\d+)?:/;

  const match_result = compilation_output.match(regex);

  if (match_result && match_result.length > 0) {
    body =
      body ||
      body +
        `detected warnings in the compilation output: <details><summary>compilation output</summary>\n\n\`\`\`\n${compilation_output}\n\`\`\`\n</details>\n`;
  }
}

if (body !== null) {
  octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pull_request_number,
    body,
  });
}
