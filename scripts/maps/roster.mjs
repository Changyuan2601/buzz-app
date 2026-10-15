// Streams Snowflake rows to the renderer. No local record cache or LLM output.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { querySpec } from "./store.mjs";

export async function* rosterFeatures(input, signal) {
  const query = querySpec(input);
  const root =
    process.env.WONDERSHOP_DIR ??
    join(homedir(), "Documents/application/wondershop/wondershop");
  const env = Object.fromEntries(
    readFileSync(join(root, ".env"), "utf8")
      .split("\n")
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.replace(/^["']|["']$/g, "")]),
  );
  const sdk = createRequire(join(root, "package.json"))("snowflake-sdk");
  sdk.configure({ logLevel: "ERROR" });
  const connection = sdk.createConnection({
    account: env.SNOWFLAKE_ACCOUNT,
    username: env.SNOWFLAKE_USER,
    role: env.SNOWFLAKE_ROLE,
    warehouse: env.SNOWFLAKE_WAREHOUSE,
    database: env.SNOWFLAKE_DATABASE,
    schema: env.SNOWFLAKE_SCHEMA,
    authenticator: env.SNOWFLAKE_AUTHENTICATOR || "externalbrowser",
    clientStoreTemporaryCredential: true,
  });
  let destroyed;
  const destroy = () =>
    (destroyed ??= new Promise((resolve) => {
      try {
        connection.destroy(resolve);
      } catch {
        resolve();
      }
    }));
  const operation = (start) =>
    new Promise((resolve, reject) => {
      const cancel = () => {
        void destroy();
        reject(new Error("Map query cancelled"));
      };
      if (signal?.aborted) {
        cancel();
        return;
      }
      signal?.addEventListener("abort", cancel, { once: true });
      const finish = (error, value) => {
        signal?.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve(value);
      };
      try {
        start(finish);
      } catch (error) {
        finish(error);
      }
    });
  const execute = (sqlText, binds = [], streamResult = false) =>
    operation((complete) => {
      connection.execute({ sqlText, binds, streamResult, complete });
    });
  try {
    await operation((complete) => {
      // connectAsync also returns a Promise; handle rejection before callback registration.
      connection
        .connectAsync((error, value) => {
          // SSO can finish after cancellation: an earlier "not connected" destroy
          // did not close this newly established session. Its callback retains ownership.
          if (!error && signal?.aborted) {
            destroyed = undefined;
            void destroy();
          }
          complete(error, value);
        })
        .catch(complete);
    });
    await execute("USE SECONDARY ROLES ALL");
    const [west, south, east, north] = query.bbox;
    const statement = await execute(
      `SELECT sha2(to_varchar(u.unit_token, 'UTF-8'), 256) AS LOCATION_ID, u.longitude AS LNG, u.latitude AS LAT, vu.business_name AS NAME,
        u.receipt_address_line_1 AS ADDRESS, u.receipt_address_locality AS LOCALITY
      FROM "ROSTER"."RAW_OLTP"."UNITS__THOMASP_DSL3_SV" u
      JOIN app_bi.hexagon.vdim_user vu ON vu.user_token = to_varchar(u.unit_token, 'UTF-8')
      WHERE u.is_active = true AND u.latitude BETWEEN ? AND ? AND u.longitude BETWEEN ? AND ?
      AND (lower(vu.business_type) LIKE ? OR lower(vu.business_category_predicted) LIKE ?
        OR lower(vu.business_sub_category_predicted) LIKE ?)
      ${query.requireAddress ? "AND length(trim(u.receipt_address_line_1)) > 0" : ""}`,
      [south, north, west, east, ...Array(3).fill(`%${query.category}%`)],
      true,
    );
    const rows = statement.streamRows();
    const cancel = () => rows.destroy(new Error("Map query cancelled"));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      for await (const row of rows) {
        const lng = Number(row.LNG),
          lat = Number(row.LAT);
        if (!Number.isFinite(lng) || !Number.isFinite(lat))
          throw new Error("Invalid source coordinates");
        if (!/^[0-9a-f]{64}$/i.test(row.LOCATION_ID ?? ""))
          throw new Error("Invalid source identity");
        yield {
          type: "Feature",
          properties: {
            id: `square-roster:${row.LOCATION_ID.toLowerCase()}`,
            label: query.category,
            name: typeof row.NAME === "string" ? row.NAME : "",
            address: [row.ADDRESS, row.LOCALITY]
              .filter((value) => typeof value === "string" && value.trim())
              .join(", "),
          },
          geometry: { type: "Point", coordinates: [lng, lat] },
        };
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      rows.destroy();
    }
  } finally {
    await destroy();
  }
}
