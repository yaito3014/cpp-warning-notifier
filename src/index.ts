import { Octokit } from "@octokit/action";

const octokit = new Octokit();

const [owner, repo] = process.env.GITHUB_REPOSITORY?.split("/")!;
const pull_request_number = parseInt(process.env.GITHUB_REF?.split("/")[2]!);

const { data: pullRequest } = await octokit.rest.pulls.get({
  owner,
  repo,
  pull_number: pull_request_number,
});

const { data: actions } = await octokit.rest.actions.listWorkflowRunsForRepo({
  owner,
  repo,
});

const workflow_runs = actions.workflow_runs.filter(
  (action) =>
    action.head_branch === pullRequest.head.ref && action.status === "completed"
);

if (workflow_runs.length === 0) {
  console.log("No workflow runs found for this pull request.");
} else {
  const latest = workflow_runs.reduce((latest, action) => {
    if (!latest) return action;
    return new Date(action.created_at) > new Date(latest.created_at)
      ? action
      : latest;
  });

  octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pull_request_number,
    body: `The latest workflow run for this pull request is [#${latest.run_number}](${latest.html_url})`,
  });
}
