// The only base `test` for browser journeys. Lint (biome.json) rejects
// importing `test` from @playwright/test anywhere else.
//
// A route handler can still be running when its test ends, for example while
// it fulfills a request that the test never waited for. Closing the page or
// context then rejects the handler's page or context calls (page.evaluate,
// route.fetch), and Playwright reports that rejection as a failure of the
// finished test. Teardown stops every route before anything closes and ignores
// errors from handlers still in flight. An error that a handler raises while
// the test runs still fails the test.
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

const closedContexts = new WeakSet();

// Fixtures that close a page themselves (fixture.mjs `app`) must call this
// first, because their teardown runs before the `context` teardown below.
export async function stopRoutes(context) {
  if (closedContexts.has(context)) return;
  await Promise.all([
    context.unrouteAll({ behavior: "ignoreErrors" }),
    ...context
      .pages()
      .filter((page) => !page.isClosed())
      .map((page) => page.unrouteAll({ behavior: "ignoreErrors" })),
  ]);
}

export const test = base.extend({
  context: async ({ context }, use) => {
    // A test may close its own context; Playwright's teardown accepts that.
    context.once("close", () => closedContexts.add(context));
    await use(context);
    await stopRoutes(context);
  },
});
