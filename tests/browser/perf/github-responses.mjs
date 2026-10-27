// Small, nonempty responses: failures/running checks and review blockers make
// an incomplete checklist distinguishable from a successful empty result.
const body =
  "Revision three benchmark description.\n\n## Implementation\n\nRender **correct data** before reporting success.";
const updated = "2026-10-26T12:00:00Z";
const bodyHtml =
  "<p>Revision three benchmark description.</p><h2>Implementation</h2><p>Render <strong>correct data</strong> before reporting success.</p>";
const checkRuns = [
  {
    name: "e2e",
    status: "completed",
    conclusion: "failure",
    details_url: "https://github.com/sample/project/actions/runs/1",
  },
  { name: "lint", status: "in_progress", conclusion: null },
];
export const responses = {
  "/__github/graphql": {
    data: {
      repository: {
        viewerDefaultMergeMethod: "SQUASH",
        squashMergeAllowed: true,
        mergeCommitAllowed: true,
        rebaseMergeAllowed: false,
        pullRequest: {
          id: "PR_9",
          title: "Benchmark change",
          state: "OPEN",
          isDraft: false,
          body,
          bodyHTML: bodyHtml,
          updatedAt: updated,
          author: { login: "contributor" },
          baseRefName: "main",
          headRefName: "fix/perf-v3",
          headRefOid: "abc123def456",
          headRepository: { nameWithOwner: "sample/project" },
          headRepositoryOwner: { login: "sample" },
          baseRepository: { nameWithOwner: "sample/project" },
          additions: 3,
          deletions: 1,
          changedFiles: 2,
          mergeStateStatus: "BLOCKED",
          reviewDecision: "CHANGES_REQUESTED",
          viewerCanUpdate: false,
          viewerCanUpdateBranch: false,
          viewerCanMergeAsAdmin: false,
          viewerCanEnableAutoMerge: false,
          viewerCanDisableAutoMerge: false,
          autoMergeRequest: null,
          reviewRequests: { nodes: [] },
          latestOpinionatedReviews: {
            nodes: [
              { author: { login: "reviewer" }, state: "CHANGES_REQUESTED" },
            ],
          },
          reviewThreads: {
            totalCount: 2,
            nodes: [{ isResolved: false }, { isResolved: false }],
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      totalCount: 3,
                      nodes: [
                        ...checkRuns.map((check) => ({
                          __typename: "CheckRun",
                          name: check.name,
                          status: check.status.toUpperCase(),
                          conclusion: check.conclusion?.toUpperCase() ?? null,
                          detailsUrl: check.details_url,
                        })),
                        {
                          __typename: "StatusContext",
                          context: "deploy",
                          state: "SUCCESS",
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  },
  "/repos/sample/project/pulls/9": {
    title: "Benchmark change",
    state: "open",
    body,
    body_html: bodyHtml,
    updated_at: updated,
    user: { login: "contributor" },
    additions: 3,
    deletions: 1,
    changed_files: 2,
    head: {
      label: "sample:fix/perf-v3",
      ref: "fix/perf-v3",
      sha: "abc123def456",
      repo: { full_name: "sample/project" },
    },
    base: { label: "main", ref: "main", repo: { full_name: "sample/project" } },
  },
  "/repos/sample/project/commits/abc123def456/check-runs": {
    total_count: 2,
    check_runs: checkRuns,
  },
  "/repos/sample/project/commits/abc123def456/status": {
    total_count: 1,
    statuses: [{ context: "deploy", state: "success" }],
  },
};
