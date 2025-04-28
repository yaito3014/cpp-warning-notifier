import { count } from "console";
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
  matrix[osName][osVersion][compilerVendor][compilerVersion][buildType] ??= [];
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

const renderHTML = (mat: any) => {
  let body = "";
  let count = 0;
  for (const [key, val] of Object.entries(mat)) {
    let temp = "";
    if (Array.isArray(val)) {
      ++count;
      temp += `<th>${key}</th>`;
      for (const elem of val) {
        temp += `<td>${elem}</td>\n`;
      }
      temp = `<tr>${temp}</tr>`;
    } else {
      const { count: innerCount, body: innerBody } = renderHTML(val);
      temp += `<th rowspan="${innerCount}">${key}</th>`;
      temp += innerBody;
    }
    body += temp;
  }
  return { count, body };
};

// Grok
// 入力データの型定義（任意の深さのネストを許容）
interface NestedData {
  [key: string]: NestedData | string[];
}

// テーブル生成のためのコンテキスト
interface TableContext {
  headers: string[]; // 動的ヘッダー（例: C++20, C++23）
  maxDepth: number; // データの最大深さ（最下層のリンク配列を除く）
}

// HTMLテーブルを生成するメイン関数
function generateTable(data: NestedData): string {
  // リンクの数とヘッダーを取得
  const context = createTableContext(data);
  const { headers, maxDepth } = context;

  // テーブルのヘッダー生成
  let table = `
<table>
  <thead>
    <tr>
      ${Array(maxDepth)
        .fill(0)
        .map((_, i) => `<th>${i === 0 ? "Platform" : "Compiler"}</th>`)
        .join("")}
      <th>Build Type</th>
      ${headers.map((header) => `<th>${header}</th>`).join("")}
    </tr>
  </thead>
  <tbody>
`;

  // ボディを再帰的に生成
  table += generateTableBody(data, [], maxDepth, context);

  // テーブル終了
  table += `
  </tbody>
</table>
`;

  return table;
}

// テーブルのコンテキストを生成（ヘッダーと最大深さを計算）
function createTableContext(data: NestedData): TableContext {
  // リンク配列に到達するまで深さを探索
  let maxDepth = 0;
  let linkCount = 0;

  function exploreDepth(obj: NestedData, depth: number) {
    for (const key in obj) {
      if (Array.isArray(obj[key])) {
        maxDepth = Math.max(maxDepth, depth);
        linkCount = (obj[key] as string[]).length;
        break;
      } else {
        exploreDepth(obj[key] as NestedData, depth + 1);
      }
    }
  }

  exploreDepth(data, 0);

  // ヘッダーを動的に生成（例: C++20, C++23, ...）
  const headers = Array.from(
    { length: linkCount },
    (_, i) => `C++${20 + i * 3}`
  );

  return { headers, maxDepth };
}

// 再帰的にテーブルボディを生成
function generateTableBody(
  data: NestedData,
  path: string[],
  maxDepth: number,
  context: TableContext
): string {
  let body = "";

  // 現在のノードがリンク配列（最下層）なら行を生成
  for (const key in data) {
    if (Array.isArray(data[key])) {
      const buildTypes = Object.keys(data);
      for (let i = 0; i < buildTypes.length; i++) {
        const buildType = buildTypes[i];
        const links = data[buildType] as string[];
        const isFirstRow = i === 0;

        body += `
        <tr>
          ${path
            .map(
              (p, idx) =>
                `<th${
                  isFirstRow && idx === path.length - 1
                    ? ` rowspan="${buildTypes.length}"`
                    : ""
                }>${p}</th>`
            )
            .join("")}
          ${
            path.length < maxDepth
              ? `<th${
                  isFirstRow ? ` rowspan="${buildTypes.length}"` : ""
                }>${key}</th>`
              : ""
          }
          <th>${buildType}</th>
          ${links.map((link) => `<td>${link}</td>`).join("")}
        </tr>
`;
      }
      return body;
    }
  }

  // リンク配列でない場合、子ノードを再帰的に処理
  for (const key in data) {
    if (!Array.isArray(data[key])) {
      body += generateTableBody(
        data[key] as NestedData,
        [...path, key],
        maxDepth,
        context
      );
    }
  }

  return body;
}

console.log("body is", body);

if (body) {
  console.log("leaving comment");
  body += generateTable(matrix);
  octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pull_request_number,
    body,
  });
}
