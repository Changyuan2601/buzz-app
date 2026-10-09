// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { FindCommunity } from "./FindCommunity";
import type { RelayFetch } from "./find-community";

const url = "https://relay.example.com:8443";
const host = "relay.example.com:8443";
const viewer = "ab".repeat(32);
const buzz = {
  name: "Buzz Relay",
  software: "https://github.com/block/buzz",
  version: "1.4.2",
  icon: "https://cdn.example.com/icon.png",
  read_state_snapshot: { community_id: "c1" },
};
const policy = {
  version: "v1",
  terms_markdown: "# Terms",
  privacy_markdown: "# Privacy",
  age_attestation_required: true,
};
afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** Answers are read when each request is made, so a test can change them before Retry. */
function relay(answers: () => Record<string, Response | Error>) {
  return vi.fn<RelayFetch>((_origin, path) => {
    const answer = answers()[path];
    if (!answer) throw new Error(`Unexpected path ${path}`);
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  });
}
const join = () => screen.getByRole("button", { name: /join/i });
const joinCommunity = () =>
  screen.queryByRole("heading", { name: "Join Community" });
/** Secondary first, primary last, as the design system's footers order them. */
const precedes = (first: HTMLElement, second: HTMLElement) =>
  Boolean(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  );

it("shows the host while finding, then only published facts, gating Join on every consent", async () => {
  const info = deferred<Response>();
  const request = relay(() => ({
    "/": new Response(null, { status: 599 }),
    "/api/join-policy": Response.json({ policy }),
  }));
  request.mockImplementationOnce(() => info.promise);
  const onJoin = vi.fn();
  const user = userEvent.setup();
  render(
    <FindCommunity
      url={url}
      onCancel={vi.fn()}
      onJoin={onJoin}
      request={request}
      titleId="t"
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toHaveAttribute("id", "t");
  expect(screen.getByRole("status")).toHaveTextContent(host);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
  await act(async () => info.resolve(Response.json(buzz)));
  expect(joinCommunity()).toBeVisible();
  expect(screen.getByText(host)).toHaveClass("font-mono");
  expect(document.querySelector("img")).toHaveAttribute(
    "src",
    "https://cdn.example.com/icon.png",
  );
  // Nothing the relay does not publish: no name, description, counts or version.
  expect(document.body).not.toHaveTextContent(/member|owner|invite|v1\.4/i);
  const terms = screen.getByRole("link", { name: "Terms of Service" });
  expect(terms).toHaveAttribute("href", `${url}/api/join-policy/terms`);
  expect(terms).toHaveAttribute("target", "_blank");
  expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
    "href",
    `${url}/api/join-policy/privacy`,
  );
  const age = screen.getByRole("checkbox", {
    name: "I am 18 years of age or older.",
  });
  const agreement = screen.getByRole("checkbox", {
    name: "I agree to the Buzz Terms of Service and Privacy Policy.",
  });
  expect(join()).toHaveTextContent("Accept and join");
  expect(join()).toBeDisabled();
  expect(precedes(screen.getByRole("button", { name: "Cancel" }), join())).toBe(
    true,
  );
  await user.click(age);
  expect(join()).toBeDisabled();
  await user.click(agreement);
  expect(join()).toBeEnabled();
  await user.click(age);
  expect(join()).toBeDisabled();
  await user.click(age);
  await user.click(join());
  expect(onJoin).toHaveBeenCalledWith({
    url,
    host,
    icon: "https://cdn.example.com/icon.png",
    policy,
    member: false,
  });
  // No key was given, so nothing was signed.
  expect(request.mock.calls.map(([origin, path]) => [origin, path])).toEqual([
    [url, "/"],
    [url, "/api/join-policy"],
  ]);
});

it("without a policy Join needs no consent, and without onJoin it stays a placeholder", async () => {
  const request = relay(() => ({
    "/": Response.json({ ...buzz, icon: undefined, version: undefined }),
    "/api/join-policy": new Response("missing", { status: 404 }),
  }));
  const view = render(
    <FindCommunity url={url} onCancel={vi.fn()} request={request} />,
  );
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(document.querySelector("img")).toBeNull();
  expect(join()).toHaveTextContent("Join — Coming soon");
  expect(join()).toBeDisabled();
  view.unmount();
  render(
    <FindCommunity
      url={url}
      onCancel={vi.fn()}
      onJoin={vi.fn()}
      request={request}
    />,
  );
  expect(await screen.findByRole("button", { name: "Join" })).toBeEnabled();
});

it("a key the relay already admits skips Join Community", async () => {
  const request = relay(() => ({
    "/": Response.json(buzz),
    "/api/join-policy": new Response("missing", { status: 404 }),
    "/query": Response.json([]),
  }));
  const onAlreadyMember = vi.fn();
  render(
    <FindCommunity
      url={url}
      viewer={viewer}
      onCancel={vi.fn()}
      onJoin={vi.fn()}
      onAlreadyMember={onAlreadyMember}
      request={request}
    />,
  );
  await vi.waitFor(() =>
    expect(onAlreadyMember).toHaveBeenCalledWith({
      url,
      host,
      icon: "https://cdn.example.com/icon.png",
      policy: null,
      member: true,
    }),
  );
  expect(request).toHaveBeenCalledWith(url, "/query", expect.any(AbortSignal), [
    { kinds: [0], authors: [viewer], limit: 1 },
  ]);
  expect(joinCommunity()).toBeNull();
  expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
});

it.each([
  ["refuses the key", new Response("denied", { status: 403 })],
  ["cannot be reached for the probe", new TypeError("fetch failed")],
])("Join Community is shown when the relay %s", async (_label, answer) => {
  const request = relay(() => ({
    "/": Response.json(buzz),
    "/api/join-policy": new Response("missing", { status: 404 }),
    "/query": answer,
  }));
  const onAlreadyMember = vi.fn();
  render(
    <FindCommunity
      url={url}
      viewer={viewer}
      onCancel={vi.fn()}
      onAlreadyMember={onAlreadyMember}
      request={request}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(onAlreadyMember).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(3);
});

it("Cancel while finding leaves at once and discards the late answer", async () => {
  const info = deferred<Response>();
  let signal: AbortSignal | undefined;
  const request = vi.fn<RelayFetch>((_origin, path, current) => {
    signal = current;
    return path === "/" ? info.promise : Promise.resolve(Response.json({}));
  });
  const onCancel = vi.fn();
  const user = userEvent.setup();
  render(<FindCommunity url={url} onCancel={onCancel} request={request} />);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(true);
  await act(async () => info.resolve(Response.json(buzz)));
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
});

it("Cancel during the membership probe aborts it and a late admission changes nothing", async () => {
  const admission = deferred<Response>();
  let probe: AbortSignal | undefined;
  const request = vi.fn<RelayFetch>((_origin, path, signal) => {
    if (path === "/query") {
      probe = signal;
      return admission.promise;
    }
    return Promise.resolve(
      path === "/" ? Response.json(buzz) : new Response(null, { status: 404 }),
    );
  });
  const onCancel = vi.fn();
  const onAlreadyMember = vi.fn();
  const user = userEvent.setup();
  render(
    <FindCommunity
      url={url}
      viewer={viewer}
      onCancel={onCancel}
      onAlreadyMember={onAlreadyMember}
      request={request}
    />,
  );
  await vi.waitFor(() => expect(probe).toBeDefined());
  expect(probe?.aborted).toBe(false);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(probe?.aborted).toBe(true);
  await act(async () => admission.resolve(Response.json([])));
  expect(onAlreadyMember).not.toHaveBeenCalled();
  expect(joinCommunity()).toBeNull();
});

it("an unreachable relay offers Retry, which looks again", async () => {
  let answers: Record<string, Response | Error> = {
    "/": new TypeError("fetch failed"),
    "/api/join-policy": new TypeError("fetch failed"),
  };
  const request = relay(() => answers);
  const user = userEvent.setup();
  render(<FindCommunity url={url} onCancel={vi.fn()} request={request} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach the relay. Check your connection and try again.",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t find community" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(
    precedes(
      screen.getByRole("button", { name: "Cancel" }),
      screen.getByRole("button", { name: "Retry" }),
    ),
  ).toBe(true);
  answers = {
    "/": Response.json(buzz),
    "/api/join-policy": Response.json({}),
  };
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(request).toHaveBeenCalledTimes(4);
});

it.each([
  [
    "an HTML page",
    new Response("<html></html>"),
    "This address isn’t a Buzz community.",
  ],
  [
    "a Buzz relay with no community here",
    Response.json({ name: "Buzz Relay" }),
    "No community is set up at this address.",
  ],
])("%s offers only Cancel", async (_label, answer, message) => {
  const request = relay(() => ({
    "/": answer,
    "/api/join-policy": Response.json({}),
  }));
  const onCancel = vi.fn();
  const user = userEvent.setup();
  render(<FindCommunity url={url} onCancel={onCancel} request={request} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});
