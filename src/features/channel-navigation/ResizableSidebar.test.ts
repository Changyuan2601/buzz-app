import { expect, it } from "vitest";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
} from "./ResizableSidebar";

it("bounds and rounds the persisted sidebar width", () => {
  expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 1)).toBe(SIDEBAR_MIN_WIDTH);
  expect(clampSidebarWidth(287.6)).toBe(288);
  expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 1)).toBe(SIDEBAR_MAX_WIDTH);
  expect(SIDEBAR_MIN_WIDTH).toBe(220);
  expect(SIDEBAR_DEFAULT_WIDTH).toBe(260);
});
