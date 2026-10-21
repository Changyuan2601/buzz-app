import { expect, it } from "vitest";
import { GlobeIcon, LockIcon } from "../../shared/design-system/icons/index";
import { channelIcon } from "./channel-icon";

it("uses a lock only for private channels", () => {
  expect(channelIcon({ private: true })).toBe(LockIcon);
  expect(channelIcon({})).toBe(GlobeIcon);
  expect(channelIcon(undefined)).toBe(GlobeIcon);
});
