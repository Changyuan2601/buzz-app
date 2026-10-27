// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { GhUnavailable, GitHubError, type GitHubCli } from "./gh";
import { GitHubPanel, REFRESH_MS } from "./index";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  ["open", false, false, "open"],
  ["open", true, false, "Draft"],
  ["closed", true, false, "closed"],
  ["closed", true, true, "Merged"],
])(
  "presents PR state with terminal states before draft: %s, draft=%s, merged=%s",
  async (state, draft, merged, label) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            title: "A small improvement",
            state,
            draft,
            merged,
            additions: 174,
            deletions: 28,
            changed_files: 6,
          }),
        ),
      ),
    );
    render(
      <GitHubPanel
        target="https://github.com/example/project/pull/1"
        close={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: "A small improvement #1" });
    expect(screen.getByText(label)).toHaveAttribute(
      "data-pr-state",
      label.toLowerCase(),
    );
    expect(screen.getByText(label).querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    const changes = screen.getByText("Changes").parentElement;
    if (!changes) throw new Error("Missing Changes row");
    expect(changes.querySelector("dd")).toHaveTextContent("+174 / −28");
  },
);

it("preserves zero counts and leaves an open issue neutral", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "A small improvement",
          state: "open",
          additions: 0,
          deletions: 0,
        }),
      ),
    ),
  );
  render(
    <GitHubPanel
      target="https://github.com/example/project/issues/1"
      close={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "A small improvement" });
  expect(screen.getByText("open")).not.toHaveAttribute("data-pr-state");
  expect(screen.getByText("+0")).toBeInTheDocument();
  expect(screen.getByText("−0")).toBeInTheDocument();
});

it("links branch labels to their own repositories and preserves unavailable branches", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "A fork contribution",
          state: "open",
          head: {
            label: "contributor:fix/small detail",
            ref: "fix/small detail",
            repo: { full_name: "contributor/project" },
          },
          base: {
            label: "example:main",
            ref: "main",
            repo: { full_name: "example/project" },
          },
        }),
      ),
    ),
  );
  const { unmount } = render(
    <GitHubPanel
      target="https://github.com/example/project/pull/1"
      close={() => {}}
    />,
  );
  const head = await screen.findByRole("link", {
    name: "contributor:fix/small detail",
  });
  expect(head).toHaveAttribute(
    "href",
    "https://github.com/contributor/project/tree/fix/small%20detail",
  );
  expect(head).toHaveAttribute("target", "_blank");
  expect(head).toHaveAttribute("rel", "noreferrer");
  expect(screen.getByRole("link", { name: "main" })).toHaveAttribute(
    "href",
    "https://github.com/example/project/tree/main",
  );
  unmount();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "An unavailable branch",
          head: { label: "contributor:deleted", ref: "deleted", repo: null },
          base: { label: "example:main" },
        }),
      ),
    ),
  );
  render(
    <GitHubPanel
      target="https://github.com/example/project/pull/2"
      close={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "An unavailable branch #2" });
  const deleted = screen.getByText("contributor:deleted");
  expect(deleted).toBeVisible();
  expect(deleted.parentElement).toHaveTextContent(
    "contributor:deleted → example:main",
  );
  expect(
    screen.queryByRole("link", { name: "contributor:deleted" }),
  ).not.toBeInTheDocument();
});

it("links the author login to their external GitHub profile", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "A small improvement",
          user: { login: "tellaho" },
        }),
      ),
    ),
  );
  render(
    <GitHubPanel
      target="https://github.com/example/project/pull/1"
      close={() => {}}
    />,
  );
  const authors = await screen.findAllByRole("link", { name: "tellaho" });
  const author = authors.find(
    (link) => link.parentElement?.textContent === "by tellaho",
  );
  expect(authors).toHaveLength(1);
  expect(author).toHaveAttribute("href", "https://github.com/tellaho");
  expect(author).toHaveAttribute("target", "_blank");
  expect(author).toHaveAttribute("rel", "noreferrer");
  expect(author?.parentElement).toHaveTextContent("by tellaho");
});

it.each([
  [
    {
      commit: { message: "A commit", author: { name: "Sample Author" } },
      owner: { login: "someone-else" },
    },
    "Sample Author",
  ],
  [{ user: { login: "invalid/profile" } }, "invalid/profile"],
])(
  "does not invent a profile for raw or invalid authors",
  async (data, name) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(data))),
    );
    render(
      <GitHubPanel
        target="https://github.com/example/project/commit/abcdef1"
        close={() => {}}
      />,
    );
    await screen.findByText(`by ${name}`);
    expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
  },
);

it("links the PR owner and repository and moves its number to the title", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ title: "A small improvement" })),
      ),
  );
  render(
    <GitHubPanel
      target="https://github.com/block/buzz-app/pull/629"
      close={() => {}}
    />,
  );
  const owner = screen.getByRole("link", { name: "block" });
  const repository = screen.getByRole("link", { name: "buzz-app" });
  expect(owner).toHaveAttribute("href", "https://github.com/block");
  expect(repository).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app",
  );
  for (const link of [owner, repository]) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  }
  const identity = screen.getByText("Pull request", {
    selector: "small",
  }).parentElement;
  expect(identity).toHaveTextContent("block / buzz-appPull request");
  expect(identity).not.toHaveTextContent("#629");
  const title = await screen.findByRole("heading", {
    name: "A small improvement #629",
  });
  expect(within(title).getByText("#629")).toBeVisible();
  const titleLink = within(title).getByRole("link", {
    name: "A small improvement #629",
  });
  expect(titleLink).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app/pull/629",
  );
  expect(titleLink).toHaveAttribute("target", "_blank");
  expect(titleLink).toHaveAttribute("rel", "noreferrer");
  expect(
    screen.queryByRole("link", { name: "Open on GitHub" }),
  ).not.toBeInTheDocument();
});

it.each([
  ["https://github.com/example/project", "Repository project"],
  ["https://github.com/example/project/issues/2", "Issue #2"],
  ["https://github.com/example/project/commit/abcdef1", "Commit abcdef1"],
])(
  "preserves the non-PR identity and title for %s",
  async (target, identity) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ title: "GitHub object" })),
        ),
    );
    render(<GitHubPanel target={target} close={() => {}} />);
    expect(screen.getByText(identity)).toBeVisible();
    expect(screen.getByText("example/project")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "example" }),
    ).not.toBeInTheDocument();
    await screen.findByRole("heading", { name: "GitHub object" });
    expect(
      screen.getByRole("link", { name: "Open on GitHub" }),
    ).toHaveAttribute("href", target);
  },
);

it.each([500])(
  "keeps the PR title and prominent external recovery action usable after API failure %s",
  async (status) => {
    const target = "https://github.com/block/buzz-app/pull/629";
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(response)
      .mockImplementation(
        async (input: string) =>
          new Response(
            JSON.stringify(
              input === "https://api.github.com/repos/block/buzz-app/pulls/629"
                ? { title: "Recovered PR" }
                : [],
            ),
          ),
      );
    vi.stubGlobal("fetch", fetch);
    render(<GitHubPanel target={target} close={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(
      screen.queryByRole("link", { name: "Open on Github" }),
    ).not.toBeInTheDocument();
    const titleLink = screen.getByRole("link", { name: "Pull request #629" });
    expect(titleLink).toHaveAttribute("href", target);
    finish(new Response(null, { status }));
    const alert = await screen.findByRole("alert");
    expect(titleLink).toBeVisible();
    const external = within(alert).getByRole("link", {
      name: "Open on Github",
    });
    const retry = within(alert).getByRole("button", { name: "Retry" });
    expect(external).toHaveAttribute("href", target);
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noreferrer");
    expect(external).toHaveAttribute("data-variant", "prominent");
    expect(retry).toHaveAttribute("data-variant", "subtle");
    expect(external.nextElementSibling).toBe(retry);
    fireEvent.click(retry);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    await screen.findByRole("heading", { name: "Recovered PR #629" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open on Github" }),
    ).not.toBeInTheDocument();
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/block/buzz-app/pulls/629",
    );
  },
);

const pull = "https://github.com/block/private/pull/9";
/** A `gh` answer for an open pull request, with `pull` overrides. */
function pullData(over: Record<string, unknown> = {}) {
  return {
    repository: {
      viewerDefaultMergeMethod: "SQUASH",
      squashMergeAllowed: true,
      mergeCommitAllowed: true,
      rebaseMergeAllowed: false,
      pullRequest: {
        id: "PR_9",
        title: "Private change",
        state: "OPEN",
        isDraft: false,
        body: "Why it changes",
        author: { login: "baxen" },
        baseRefName: "main",
        headRefName: "fix",
        headRefOid: "abc123",
        headRepository: { nameWithOwner: "block/private" },
        headRepositoryOwner: { login: "block" },
        baseRepository: { nameWithOwner: "block/private" },
        additions: 3,
        deletions: 1,
        changedFiles: 2,
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        viewerCanUpdate: true,
        viewerCanUpdateBranch: true,
        viewerCanMergeAsAdmin: false,
        viewerCanEnableAutoMerge: false,
        viewerCanDisableAutoMerge: false,
        autoMergeRequest: null,
        reviewRequests: { nodes: [] },
        latestOpinionatedReviews: {
          nodes: [{ author: { login: "wes" }, state: "APPROVED" }],
        },
        reviewThreads: { nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    totalCount: 2,
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "unit",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                      },
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
        ...over,
      },
    },
  };
}
const checklist = () =>
  screen.getByRole("list", { name: "Pull request checklist" });
const row = (label: string) =>
  within(checklist()).getByText(label).closest("li") as HTMLElement;

it("reads a private pull request with gh as one checklist, without the public API", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const gh = vi.fn(async () =>
    pullData({
      mergeStateStatus: "BLOCKED",
      reviewDecision: "CHANGES_REQUESTED",
      latestOpinionatedReviews: {
        nodes: [{ author: { login: "wes" }, state: "CHANGES_REQUESTED" }],
      },
      reviewThreads: {
        nodes: [
          { isResolved: false },
          { isResolved: true },
          { isResolved: false },
        ],
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  totalCount: 3,
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "e2e",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                      detailsUrl: "https://github.com/block/private/runs/1",
                    },
                    {
                      __typename: "CheckRun",
                      name: "lint",
                      status: "IN_PROGRESS",
                      conclusion: null,
                    },
                    {
                      __typename: "CheckRun",
                      name: "unit",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    }),
  ) as unknown as GitHubCli;
  render(<GitHubPanel target={pull} close={() => {}} gh={gh} />);
  await screen.findByRole("heading", { name: "Private change #9" });
  expect(row("Checks")).toHaveTextContent("1 failed · 1 running · 1 passed");
  expect(row("Checks")).toHaveAttribute("data-tone", "failure");
  expect(
    within(row("Checks")).queryByRole("link", { name: "e2e" }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    within(row("Checks")).getByRole("button", {
      name: "1 failed · 1 running · 1 passed",
    }),
  );
  expect(
    within(row("Checks")).getByRole("link", { name: "e2e" }),
  ).toHaveAttribute("href", "https://github.com/block/private/runs/1");
  expect(row("Review")).toHaveTextContent("Changes requested by wes");
  expect(row("Threads")).toHaveTextContent("2 unresolved");
  expect(row("Merge")).toHaveTextContent("Blocked by main’s rules");
  expect(row("Merge")).not.toHaveTextContent("bypass");
  // Blocked, and this viewer cannot bypass: nothing to merge with.
  expect(
    screen.queryByRole("button", { name: /merge/i }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Read with your gh sign-in.")).toBeInTheDocument();
  expect(screen.getByText("Changes").parentElement).toHaveTextContent(
    "+3 / −1",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("falls back to public data when gh is unavailable, and says why private links fail", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/pulls/9")
        ? new Response(null, { status: 404 })
        : new Response("{}"),
    ),
  );
  const gh = vi.fn(async () => {
    throw new GhUnavailable("To get started with GitHub CLI");
  }) as unknown as GitHubCli;
  render(<GitHubPanel target={pull} close={() => {}} gh={gh} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign in to the gh CLI to see private repositories",
  );
});

it("says when the signed-in account cannot see it, without falling back", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const gh = vi.fn(async () => {
    throw new GitHubError("Could not resolve", "NOT_FOUND");
  }) as unknown as GitHubCli;
  render(<GitHubPanel target={pull} close={() => {}} gh={gh} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "your GitHub account can’t see it",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("merges after confirming, at the head it showed, then shows it merged", async () => {
  const user = userEvent.setup();
  let merged = false;
  const gh = vi.fn(async (query: string) => {
    if (query.startsWith("mutation")) {
      merged = true;
      return {};
    }
    return merged
      ? pullData({
          state: "MERGED",
          mergedBy: { login: "baxen" },
          mergedAt: new Date().toISOString(),
        })
      : pullData();
  });
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  expect(row("Checks")).toHaveTextContent("All 2 passed");
  expect(row("Review")).toHaveTextContent("Approved by wes");
  expect(row("Threads")).toHaveTextContent("None unresolved");
  expect(row("Merge")).toHaveTextContent("Ready to merge into main");
  await user.click(screen.getByRole("button", { name: "Squash and merge" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(gh).toHaveBeenCalledTimes(1);
  await user.click(within(dialog).getByRole("button", { name: "Merge" }));
  await screen.findByText(/Merged into/);
  expect(screen.getByText(/Merged into/)).toHaveTextContent(
    "Merged into main by baxen",
  );
  expect(gh.mock.calls[1]).toEqual([
    "mutation($input:MergePullRequestInput!){mergePullRequest(input:$input){clientMutationId}}",
    {
      input: {
        pullRequestId: "PR_9",
        expectedHeadOid: "abc123",
        mergeMethod: "SQUASH",
      },
    },
    undefined,
  ]);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

it("closes the merge confirmation when a refresh brings a newer push", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let head = "abc123";
    const gh = vi.fn(async (query: string, _variables?: unknown) =>
      query.startsWith("mutation")
        ? {}
        : pullData({
            headRefOid: head,
            ...(head !== "abc123" && { title: "Pushed again" }),
          }),
    );
    render(
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />,
    );
    await screen.findByRole("heading", { name: "Private change #9" });
    await user.click(screen.getByRole("button", { name: "Squash and merge" }));
    const dialog = await screen.findByRole("alertdialog");
    head = "def456";
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await screen.findByRole("heading", { name: "Pushed again #9" });
    expect(dialog).not.toBeInTheDocument();
    // Confirming again names the head now shown.
    await user.click(screen.getByRole("button", { name: "Squash and merge" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Merge",
      }),
    );
    await vi.waitFor(() => expect(gh).toHaveBeenCalledTimes(4));
    expect(gh.mock.calls[2]?.[1]).toEqual({
      input: {
        pullRequestId: "PR_9",
        expectedHeadOid: "def456",
        mergeMethod: "SQUASH",
      },
    });
  } finally {
    vi.useRealTimers();
  }
});

it("closes the merge confirmation when the pull request is retargeted, for good", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let base = "main";
    const gh = vi.fn(async () =>
      pullData({
        baseRefName: base,
        ...(base !== "main" && { title: "Retargeted" }),
      }),
    );
    render(
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />,
    );
    await screen.findByRole("heading", { name: "Private change #9" });
    await user.click(screen.getByRole("button", { name: "Squash and merge" }));
    const dialog = await screen.findByRole("alertdialog");
    base = "release";
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await screen.findByRole("heading", { name: "Retargeted #9" });
    expect(dialog).not.toBeInTheDocument();
    // Changing back does not open it again without another click.
    base = "main";
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await screen.findByRole("heading", { name: "Private change #9" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("says when threads beyond the latest 100 went unread, and gates actions on GitHub's viewer flags", async () => {
  const gh = vi.fn(async () =>
    pullData({
      mergeStateStatus: "BEHIND",
      viewerCanUpdateBranch: false,
      reviewThreads: { totalCount: 101, nodes: [{ isResolved: true }] },
    }),
  );
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  expect(row("Threads")).toHaveTextContent("0 unresolved in the latest 100");
  expect(
    screen.queryByRole("button", { name: "Update branch" }),
  ).not.toBeInTheDocument();
});

it("keeps the confirmation open with GitHub's reason when a merge fails, under StrictMode", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async (query: string) => {
    if (query.startsWith("mutation"))
      throw new GitHubError(
        "Head branch was modified. Review and try the merge again.",
      );
    return pullData();
  });
  // StrictMode replays effect cleanup, which must not leave the panel deaf.
  render(
    <StrictMode>
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />
    </StrictMode>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Squash and merge" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Merge" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Head branch was modified",
  );
});

it("offers a bypass merge to admins, and other methods and drafting in the menu", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async () =>
    pullData({ mergeStateStatus: "BLOCKED", viewerCanMergeAsAdmin: true }),
  );
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  const merge = await screen.findByRole("button", { name: "Squash and merge" });
  expect(merge).toHaveAttribute("data-variant", "attention");
  expect(row("Merge")).toHaveTextContent("you can bypass them");
  await user.click(
    screen.getByRole("button", { name: "More pull request actions" }),
  );
  expect(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
  ).toEqual(["Create a merge commit", "Convert to draft"]);
  await user.click(
    screen.getByRole("menuitem", { name: "Create a merge commit" }),
  );
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "This bypasses main’s branch rules",
  );
});

it("opens the merge confirmation without an earlier action's error", async () => {
  const user = userEvent.setup();
  const gh = vi.fn(async (query: string) => {
    if (query.startsWith("mutation"))
      throw new GitHubError("Could not convert to draft");
    return pullData({ viewerCanMergeAsAdmin: true });
  });
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "More pull request actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Convert to draft" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not convert to draft",
  );
  await user.click(screen.getByRole("button", { name: "Squash and merge" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
});

it("marks a draft ready for review, and offers auto-merge while blocked", async () => {
  const user = userEvent.setup();
  let draft = true;
  const gh = vi.fn(async (query: string) => {
    if (query.startsWith("mutation")) {
      draft = false;
      return {};
    }
    return pullData({
      isDraft: draft,
      mergeStateStatus: draft ? "DRAFT" : "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
      latestOpinionatedReviews: { nodes: [] },
      reviewRequests: {
        nodes: [{ requestedReviewer: { login: "wes" } }],
      },
    });
  });
  const { rerender } = render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Ready for review" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Ready for review" }),
    ).not.toBeInTheDocument(),
  );
  expect(gh.mock.calls[1]?.[0]).toContain("markPullRequestReadyForReview");
  expect(row("Review")).toHaveTextContent("Required · waiting on wes");
  expect(
    screen.queryByRole("button", { name: "Merge when ready" }),
  ).not.toBeInTheDocument();
  // Where the repository allows it, a blocked pull request can merge itself.
  gh.mockImplementation(async () =>
    pullData({ mergeStateStatus: "BLOCKED", viewerCanEnableAutoMerge: true }),
  );
  rerender(
    <GitHubPanel
      target={`${pull}0`}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  expect(
    await screen.findByRole("button", { name: "Merge when ready" }),
  ).toBeInTheDocument();
});

it("reads an open pull request again while the panel is open", async () => {
  vi.useFakeTimers();
  try {
    const gh = vi.fn(async () => pullData());
    render(
      <GitHubPanel
        target={pull}
        close={() => {}}
        gh={gh as unknown as GitHubCli}
      />,
    );
    await vi.waitFor(() =>
      screen.getByRole("heading", { name: "Private change #9" }),
    );
    expect(gh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(gh).toHaveBeenCalledTimes(2);
    // A merged pull request doesn't change, so it isn't read again.
    gh.mockImplementation(async () => pullData({ state: "MERGED" }));
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(gh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    expect(gh).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a required review pending while an approval is in", async () => {
  const gh = vi.fn(async () =>
    pullData({
      reviewDecision: "REVIEW_REQUIRED",
      reviewRequests: {
        nodes: [{ requestedReviewer: { login: "kalvin" } }],
      },
    }),
  );
  render(
    <GitHubPanel
      target={pull}
      close={() => {}}
      gh={gh as unknown as GitHubCli}
    />,
  );
  await screen.findByRole("heading", { name: "Private change #9" });
  expect(row("Review")).toHaveTextContent(
    "Required · approved by wes · waiting on kalvin",
  );
});

it("places each resolution action in its matching checklist row", async () => {
  const data = pullData({ mergeStateStatus: "DIRTY" });
  const check =
    data.repository.pullRequest.commits.nodes[0]?.commit.statusCheckRollup
      .contexts.nodes[0];
  if (!check) throw new Error("Missing fixture check");
  check.conclusion = "FAILURE";
  const gh = vi.fn(async () => data) as GitHubCli;
  render(
    <GitHubPanel
      target="https://github.com/block/private/pull/9"
      close={() => {}}
      gh={gh}
      resolveActions={(_url, _pull, action) => (
        <button type="button">Resolve {action}</button>
      )}
    />,
  );
  await screen.findByRole("button", { name: "Resolve failures" });
  expect(
    within(row("Checks")).getByRole("button", { name: "Resolve failures" }),
  ).toBeInTheDocument();
  expect(
    within(row("Merge")).getByRole("button", { name: "Resolve conflicts" }),
  ).toBeInTheDocument();
  expect(within(row("Review")).queryByRole("button")).not.toBeInTheDocument();
  expect(within(row("Threads")).queryByRole("button")).not.toBeInTheDocument();
});
