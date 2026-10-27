// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { waitFor } from "@testing-library/dom";
import { expect, it } from "vitest";
import { provideNavigation } from "./service";

it("does not resume a covered workspace when history jumps to an older visit of the same target", async () => {
  window.history.replaceState(null, "", "/");
  const ctx = new Context();
  const host = provideNavigation(ctx, window);
  const nav = host.navigation;
  const target = {
    version: 1,
    kind: "page",
    pluginId: "test",
    pageId: "x",
  } as const;
  try {
    void nav.open(target);
    const older = nav.snapshot().entry.id;
    void nav.open({ ...target, pageId: "y" });
    void nav.open(target);
    const covered = host.request(
      nav.snapshot().attempt,
      {
        valid: () => true,
        subscribe: () => () => {},
      },
      true,
    );
    void nav.open({ version: 1, kind: "settings", section: "appearance" });
    void nav.open({ version: 1, kind: "settings", section: "notifications" });
    // Skip the intermediate page and the newer covered visit in one traversal.
    window.history.go(-3);
    await waitFor(() => expect(nav.snapshot().entry.id).toBe(older));
    expect(covered.request.signal.aborted).toBe(true);
    expect(covered.resume(nav.snapshot().attempt)).toBe(false);
    expect(covered.request.complete({ status: "opened" })).toBe(false);
  } finally {
    await ctx.fiber.dispose();
    window.history.replaceState(null, "", "/");
  }
});
