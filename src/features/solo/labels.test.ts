import { expect, it } from "vitest";
import {
  ownSolo,
  SOLO_NAMED_LABEL,
  SOLO_LABEL,
  soloChatLinkName,
  soloLabels,
} from "./labels";

const id = "22222222-2222-4222-8222-222222222222";
const owner = "a".repeat(64);
const guest = "b".repeat(64);

it("shares IDs until a chosen name is recorded, never an automatic first prompt", () => {
  const channel = { id, name: "Private first prompt" };
  expect(soloChatLinkName(channel)).toBe("22222222");
  expect(soloChatLinkName({ ...channel, labels: ["work"] })).toBe("22222222");
  expect(
    soloChatLinkName({
      ...channel,
      name: "PR 45 fixes",
      labels: [SOLO_NAMED_LABEL],
    }),
  ).toBe("PR 45 fixes");
});

it("marks Solo only with its channel label", () => {
  expect(soloLabels([SOLO_LABEL])).toBe(true);
  expect(soloLabels([SOLO_NAMED_LABEL, SOLO_LABEL])).toBe(true);
  expect(soloLabels([SOLO_NAMED_LABEL])).toBe(false);
  expect(soloLabels([])).toBe(false);
  expect(soloLabels(undefined)).toBe(false);
});

it("files a Solo chat as the viewer's own only when they created it", () => {
  const solo = { channelType: "solo", creator: owner };
  expect(ownSolo(solo, owner)).toBe(true);
  expect(ownSolo(solo, guest)).toBe(false);
  expect(ownSolo(solo, undefined)).toBe(false);
  expect(ownSolo({ channelType: "solo" }, owner)).toBe(false);
  expect(ownSolo({ channelType: "stream", creator: owner }, owner)).toBe(false);
  expect(ownSolo(undefined, owner)).toBe(false);
});
