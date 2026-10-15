// Agent tool: publish a query reference, never materialize seller rows in chat.
import { join, dirname, delimiter, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mapStore, querySpec } from "./store.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
try {
  const scope = option("--scope"),
    channel = option("--channel"),
    requestId = option("--request-id");
  if (
    !/^https:\/\/.+:[0-9a-f]{64}$/.test(scope ?? "") ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(channel ?? "") ||
    !/^[0-9a-f-]{36}$/.test(requestId ?? "")
  )
    throw new Error("Invalid map request");
  const origin = scope.slice(0, -65);
  const relay = new URL(process.env.BUZZ_RELAY_URL ?? "");
  relay.protocol = "https:";
  if (relay.origin !== origin)
    throw new Error("Dataset must stay in the incoming community");
  const query = querySpec({
    source: "square-roster",
    category: option("--category"),
    bbox: (option("--bbox") ?? "").split(",").map(Number),
    requireAddress: args.includes("--require-address"),
  });
  const store = mapStore(
    join(dirname(fileURLToPath(import.meta.url)), "../../.buzz/maps.sqlite"),
  );
  let id;
  try {
    id = store.create(scope, channel, query);
  } finally {
    store.close();
  }
  let buzz;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "buzz");
    if (!existsSync(candidate)) continue;
    const target = realpathSync(candidate);
    buzz =
      basename(target) === "buzz-dev-mcp"
        ? join(dirname(target), "buzz")
        : candidate;
    break;
  }
  if (!buzz) throw new Error("Buzz CLI unavailable");
  const [w, s, e, n] = query.bbox;
  const reply = {
    requestId,
    message: "🤖 Loading matching Square locations directly from Snowflake.",
    map: {
      center: [(w + e) / 2, (s + n) / 2],
      zoom: 14,
      datasets: [id],
    },
  };
  const result = spawnSync(
    buzz,
    [
      "messages",
      "send",
      "--channel",
      channel,
      ...(option("--reply-to") ? ["--reply-to", option("--reply-to")] : []),
      "--content",
      "-",
    ],
    { input: JSON.stringify(reply), encoding: "utf8", timeout: 30000 },
  );
  if (result.status !== 0)
    throw new Error("Dataset saved but channel publication failed");
  console.log(JSON.stringify({ published: true, datasetId: id }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
