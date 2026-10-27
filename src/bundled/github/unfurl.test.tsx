// @vitest-environment jsdom
import { expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { createUnfurlComponent, unfurlMatches, _clearCache } from "./unfurl";

beforeEach(() => _clearCache());

it("matches only pull request and issue URLs", () => {
  expect(unfurlMatches("https://github.com/block/buzz/pull/42")).toBe(true);
  expect(unfurlMatches("https://github.com/block/buzz/issues/7")).toBe(true);
  expect(unfurlMatches("https://github.com/block/buzz")).toBe(false);
  expect(unfurlMatches("https://github.com/block/buzz/commit/abc1234")).toBe(
    false,
  );
  expect(unfurlMatches("https://example.com/pull/1")).toBe(false);
});

it("shows the short label before the title loads", () => {
  const Component = createUnfurlComponent(undefined);
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
  const { container } = render(
    <Component url="https://github.com/block/buzz/pull/42" />,
  );
  expect(container.textContent).toBe("block/buzz#42");
});

it("appends the title after loading via gh", async () => {
  const gh = vi.fn().mockResolvedValue({
    repository: {
      issueOrPullRequest: { title: "Fix the thing" },
    },
  });
  const Component = createUnfurlComponent(gh);
  const { container } = render(
    <Component url="https://github.com/block/buzz/pull/42" />,
  );
  await waitFor(() =>
    expect(container.textContent).toBe("block/buzz#42 · Fix the thing"),
  );
  expect(gh).toHaveBeenCalledOnce();
});

it("falls back to the public API when gh is unavailable", async () => {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ title: "Public title" }), { status: 200 }),
    );
  const Component = createUnfurlComponent(undefined);
  const { container } = render(
    <Component url="https://github.com/block/buzz/issues/7" />,
  );
  await waitFor(() =>
    expect(container.textContent).toBe("block/buzz#7 · Public title"),
  );
  expect(fetchSpy).toHaveBeenCalledOnce();
  expect(fetchSpy.mock.calls[0]?.[0]).toContain("/repos/block/buzz/issues/7");
});

it("deduplicates concurrent fetches for the same URL", async () => {
  const gh = vi.fn().mockResolvedValue({
    repository: {
      issueOrPullRequest: { title: "Shared" },
    },
  });
  const Component = createUnfurlComponent(gh);
  const { container } = render(
    <>
      <Component url="https://github.com/block/buzz/pull/1" />
      <Component url="https://github.com/block/buzz/pull/1" />
    </>,
  );
  await waitFor(() =>
    expect(container.textContent).toBe(
      "block/buzz#1 · Sharedblock/buzz#1 · Shared",
    ),
  );
  expect(gh).toHaveBeenCalledOnce();
});

it("keeps the label when the fetch fails", async () => {
  const gh = vi.fn().mockRejectedValue(new Error("offline"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  const Component = createUnfurlComponent(gh);
  const { container } = render(
    <Component url="https://github.com/block/buzz/pull/99" />,
  );
  await waitFor(() => expect(gh).toHaveBeenCalledOnce());
  expect(container.textContent).toBe("block/buzz#99");
});

it("handles URLs with query parameters", async () => {
  const gh = vi.fn().mockResolvedValue({
    repository: {
      issueOrPullRequest: { title: "Query param PR" },
    },
  });
  const Component = createUnfurlComponent(gh);
  const { container } = render(
    <Component url="https://github.com/block/buzz/pull/42?view=all" />,
  );
  await waitFor(() =>
    expect(container.textContent).toBe("block/buzz#42 · Query param PR"),
  );
  expect(gh).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ number: 42 }),
  );
});

it("renders the GitHub icon", () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
  const Component = createUnfurlComponent(undefined);
  const { container } = render(
    <Component url="https://github.com/block/buzz/pull/1" />,
  );
  expect(container.querySelector("[aria-hidden]")).toBeTruthy();
  expect(container.querySelector("[data-link-kind='github']")).toBeTruthy();
});
