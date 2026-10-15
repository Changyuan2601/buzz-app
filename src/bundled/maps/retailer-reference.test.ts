import { expect, it } from "vitest";
import { composerResource } from "../../features/messages/composer-document";
import { parseBuzzLink } from "../../features/navigation/buzz-links";
import { readRetailerReference, retailerResource } from "./retailer-reference";

it("keeps one explicit business snapshot in a navigation-safe resource with a name-only label", () => {
  const location = {
    id: `square-roster:${"a".repeat(64)}`,
    name: "Café [Books] & More",
    address: "200 O’Farrell St, San Francisco",
    coordinates: [-122.4, 37.7] as [number, number],
  };
  const resource = retailerResource(location, "map-channel");
  if (!resource) throw new Error("Expected a business resource");
  expect(resource.label).toBe(location.name);
  expect(readRetailerReference(resource.uri)).toEqual({
    channel: "map-channel",
    location,
  });
  expect(parseBuzzLink(resource.uri)).toEqual({
    format: "legacy",
    channelId: "map-channel",
  });
  expect(composerResource(resource)?.source).toBe(
    `[Café \\[Books\\] \\& More](${resource.uri})`,
  );
  expect(resource.uri).not.toContain("note");
});

it("rejects malformed references and strips fields not belonging to the selected business", () => {
  const location = {
    name: "Books",
    address: "Example St",
    coordinates: [0, 0] as [number, number],
  };
  expect(retailerResource({ ...location, address: "" }, "map")).toBeUndefined();
  expect(
    retailerResource({ ...location, coordinates: [200, 0] }, "map"),
  ).toBeUndefined();
  expect(retailerResource(location, "bad/channel")).toBeUndefined();
  const resource = retailerResource(location, "map");
  if (!resource) throw new Error("Expected a business resource");
  const uri = new URL(resource.uri);
  uri.searchParams.set(
    "retailer",
    JSON.stringify({ ...location, version: 1, notes: "Private draft" }),
  );
  expect(readRetailerReference(uri.href)?.location).toEqual(location);
  uri.searchParams.append("retailer", "{}");
  expect(readRetailerReference(uri.href)).toBeUndefined();
  expect(readRetailerReference("javascript:alert(1)")).toBeUndefined();
  expect(
    readRetailerReference("buzz://channel/map?retailer=bad-json"),
  ).toBeUndefined();
});
