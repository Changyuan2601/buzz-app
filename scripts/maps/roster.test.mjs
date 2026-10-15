import { expect, it, vi } from "vitest";
import { Readable } from "node:stream";
const fixture = vi.hoisted(() => ({ connection: undefined }));
vi.mock("node:module", () => ({
  createRequire: () => () => ({
    configure() {},
    createConnection: () => fixture.connection,
  }),
}));
vi.mock("node:fs", async (actual) => ({
  ...(await actual()),
  readFileSync: () => "SNOWFLAKE_ACCOUNT=test\nSNOWFLAKE_USER=test",
}));
import { rosterFeatures } from "./roster.mjs";

it("streams stable opaque location IDs and renderer details without raw tokens", async () => {
  const execute = vi.fn(({ complete }) => {
    complete(undefined, {
      streamRows: () =>
        Readable.from([
          {
            LOCATION_ID: "A".repeat(64),
            LNG: -122.42,
            LAT: 37.77,
            NAME: "Example Books",
            ADDRESS: "123 Example Street",
            LOCALITY: "San Francisco",
          },
        ]),
    });
  });
  const destroy = vi.fn((done) => done());
  fixture.connection = {
    connectAsync(done) {
      done();
      return Promise.resolve();
    },
    execute,
    destroy,
  };
  const query = {
    source: "square-roster",
    category: "books",
    bbox: [-123, 37, -122, 38],
    requireAddress: false,
  };
  const records = [];
  for await (const feature of rosterFeatures(query)) records.push(feature);
  expect(records).toEqual([
    {
      type: "Feature",
      properties: {
        id: `square-roster:${"a".repeat(64)}`,
        label: "books",
        name: "Example Books",
        address: "123 Example Street, San Francisco",
      },
      geometry: { type: "Point", coordinates: [-122.42, 37.77] },
    },
  ]);
  expect(execute.mock.calls[1][0].sqlText).toContain(
    "sha2(to_varchar(u.unit_token, 'UTF-8'), 256) AS LOCATION_ID",
  );
  expect(execute.mock.calls[1][0].binds).toEqual([
    37,
    38,
    -123,
    -122,
    "%books%",
    "%books%",
    "%books%",
  ]);
  expect(destroy).toHaveBeenCalledOnce();
});

it("owns a successful SSO connection even when it arrives after cancellation", async () => {
  let connected = false,
    finishConnect,
    started;
  const connecting = new Promise((resolve) => {
    started = resolve;
  });
  const destroy = vi.fn((callback) => {
    const error = connected ? undefined : new Error("Not connected");
    connected = false;
    callback(error);
  });
  fixture.connection = {
    connectAsync(callback) {
      finishConnect = callback;
      started();
      return Promise.resolve();
    },
    destroy,
  };
  const abort = new AbortController();
  const stream = rosterFeatures(
    {
      source: "square-roster",
      category: "hair_salon",
      bbox: [-123, 37, -122, 38],
      requireAddress: true,
    },
    abort.signal,
  );
  const next = stream.next();
  const cancelled = expect(next).rejects.toThrow("cancelled");
  try {
    await connecting;
    abort.abort();
    await cancelled;
    expect(destroy).toHaveBeenCalledTimes(1);
    connected = true;
    finishConnect();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(connected).toBe(false);
  } finally {
    abort.abort();
    await stream.return();
  }
});
