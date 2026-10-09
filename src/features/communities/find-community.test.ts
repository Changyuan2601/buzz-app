import { expect, it, vi } from "vitest";
import {
  FindCommunityError,
  findCommunity,
  type RelayFetch,
} from "./find-community";

const url = "https://relay.example.com:8443";
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
  privacy_markdown: null,
  age_attestation_required: true,
};
type Answer = Response | Error;
const html = (status = 200) =>
  new Response("<html><body>Hi</body></html>", { status });
function fetcher(answers: Record<string, Answer>) {
  return vi.fn<RelayFetch>((_origin, path) => {
    const answer = answers[path];
    if (!answer) throw new Error(`Unexpected path ${path}`);
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  });
}
const find = (answers: Record<string, Answer>, who?: string) =>
  findCommunity(url, fetcher(answers), new AbortController().signal, who);
const failure = (answers: Record<string, Answer>) =>
  find(answers).then(
    () => "found",
    (error: unknown) =>
      error instanceof FindCommunityError ? error.failure : error,
  );

it("reports only what the relay publishes, with the icon sanitized", async () => {
  await expect(
    find({
      "/": Response.json(buzz),
      "/api/join-policy": Response.json({ policy }),
    }),
  ).resolves.toEqual({
    url,
    host: "relay.example.com:8443",
    icon: "https://cdn.example.com/icon.png",
    policy: {
      version: "v1",
      terms_markdown: "# Terms",
      privacy_markdown: undefined,
      age_attestation_required: true,
    },
    member: false,
  });
  await expect(
    find({
      "/": Response.json({
        software: "https://github.com/block/buzz",
        buzz_v1: {},
        icon: "javascript:alert(1)",
        version: 3,
      }),
      "/api/join-policy": Response.json({}),
    }),
  ).resolves.toEqual({
    url,
    host: "relay.example.com:8443",
    icon: undefined,
    policy: null,
    member: false,
  });
});

it.each([
  ["a network failure", { "/": new TypeError("fetch failed") }, "unreachable"],
  ["a relay 5xx", { "/": html(503) }, "unreachable"],
  ["an HTML page", { "/": html() }, "not-buzz"],
  ["a 404", { "/": html(404) }, "not-buzz"],
  ["a JSON array", { "/": Response.json([]) }, "not-buzz"],
  [
    "another relay implementation",
    { "/": Response.json({ name: "strfry", software: "git+https://x" }) },
    "not-buzz",
  ],
  [
    "a Buzz relay with no community bound to this host",
    {
      "/": Response.json({ name: "Buzz Relay", version: "1.4.2" }),
      "/api/join-policy": Response.json({}),
    },
    "no-community",
  ],
] as const)(
  "classifies NIP-11 answered by %s",
  async (_label, answers, failure_) => {
    await expect(
      failure({ "/api/join-policy": html(404), ...answers }),
    ).resolves.toBe(failure_);
  },
);

it.each([
  ["404", html(404), null],
  ["{}", Response.json({}), null],
  ["{policy:null}", Response.json({ policy: null }), null],
  ["a network failure", new TypeError("fetch failed"), "unreachable"],
  ["a 5xx", html(500), "unreachable"],
  ["a redirect", new Response(null, { status: 302 }), "unreachable"],
  ["HTML", html(), "unreachable"],
  [
    "a malformed policy",
    Response.json({ policy: { version: 1 } }),
    "unreachable",
  ],
  ["a JSON array", Response.json([]), "unreachable"],
])(
  "treats a join policy answered by %s as %j once NIP-11 is a Buzz relay",
  async (_label, answer, expected) => {
    const result = await failure({
      "/": Response.json(buzz),
      "/api/join-policy": answer,
    }).then((value) => (value === "found" ? null : value));
    expect(result).toBe(expected);
  },
);

it("asks a confirmed Buzz relay whether the viewer's key is already admitted", async () => {
  const request = fetcher({
    "/": Response.json(buzz),
    "/api/join-policy": html(404),
    "/query": Response.json([]),
  });
  const found = await findCommunity(
    url,
    request,
    new AbortController().signal,
    viewer,
  );
  expect(found.member).toBe(true);
  expect(request).toHaveBeenCalledWith(url, "/query", expect.any(AbortSignal), [
    { kinds: [0], authors: [viewer], limit: 1 },
  ]);
});

it.each([
  ["a 403", new Response("denied", { status: 403 })],
  ["a 401", new Response("auth", { status: 401 })],
  ["a 5xx", html(502)],
  ["a network failure", new TypeError("fetch failed")],
])(
  "a membership probe answered by %s is not membership",
  async (_label, answer) => {
    await expect(
      find(
        {
          "/": Response.json(buzz),
          "/api/join-policy": html(404),
          "/query": answer,
        },
        viewer,
      ),
    ).resolves.toMatchObject({ member: false });
  },
);

it("never signs a query without a key or for a host NIP-11 does not vouch for", async () => {
  const anonymous = fetcher({
    "/": Response.json(buzz),
    "/api/join-policy": html(404),
  });
  await findCommunity(url, anonymous, new AbortController().signal);
  const stranger = fetcher({
    "/": Response.json({ name: "strfry" }),
    "/api/join-policy": html(404),
  });
  await findCommunity(
    url,
    stranger,
    new AbortController().signal,
    viewer,
  ).catch(() => {});
  for (const request of [anonymous, stranger])
    expect(request.mock.calls.map(([, path]) => path)).toEqual([
      "/",
      "/api/join-policy",
    ]);
});

it("reads both documents at once and lets the NIP-11 verdict win", async () => {
  const paths: string[] = [];
  const release: Array<() => void> = [];
  const request: RelayFetch = (_origin, path) => {
    paths.push(path);
    return new Promise<Response>((resolve) =>
      release.push(() =>
        resolve(path === "/" ? html() : Response.json({ policy })),
      ),
    );
  };
  const found = findCommunity(url, request, new AbortController().signal);
  await vi.waitFor(() => expect(paths).toEqual(["/", "/api/join-policy"]));
  for (const resolve of release) resolve();
  await expect(found).rejects.toMatchObject({ failure: "not-buzz" });
});

it("passes the caller's abort through instead of calling it unreachable", async () => {
  const controller = new AbortController();
  const request: RelayFetch = (_origin, _path, signal) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
  const found = findCommunity(url, request, controller.signal);
  controller.abort(new Error("left the page"));
  await expect(found).rejects.toThrow("left the page");
});

it("an abort during the membership probe is the caller's, not a verdict", async () => {
  const controller = new AbortController();
  const paths: string[] = [];
  const request: RelayFetch = (_origin, path, signal) => {
    paths.push(path);
    return path === "/query"
      ? new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        )
      : Promise.resolve(path === "/" ? Response.json(buzz) : html(404));
  };
  const found = findCommunity(url, request, controller.signal, viewer);
  await vi.waitFor(() => expect(paths).toContain("/query"));
  controller.abort(new Error("left the page"));
  await expect(found).rejects.toThrow("left the page");
});
