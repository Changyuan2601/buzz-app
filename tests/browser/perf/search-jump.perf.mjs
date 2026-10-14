// Search result -> message in another channel: from the click on the result
// until the target is focused where it ends up, and how far it moves once
// placed (the closing palette covers it meanwhile, so placement is
// geometric). Cases, from Home: inline-cold and inline-warm (head messages
// above the bottom-pinned view of one channel), deep-cold (90 rows back),
// reply-cold (a reply in a 60-reply thread, revealed in the Thread panel).
import { corpusOptions, expect, test } from "./harness.mjs";
import { focused, frames, placement } from "./metrics.mjs";

const HOME = "5c1b6c61-6464-4472-8000-0000000000d0";
const S1 = "5c1b6c61-6464-4472-8000-0000000000d1";
const S2 = "5c1b6c61-6464-4472-8000-0000000000d2";
const S3 = "5c1b6c61-6464-4472-8000-0000000000d3";
test.use(
  corpusOptions(
    {
      // 17 and 19 rows from the newest: in the 20-row head, above the view.
      [S1]: {
        name: "Sierra one",
        count: 160,
        seed: 43,
        marks: { inline: 17, warm: 19 },
      },
      [S2]: { name: "Sierra two", count: 160, seed: 42, marks: { deep: 90 } },
      [S3]: {
        name: "Sierra three",
        count: 60,
        seed: 44,
        longThread: { replies: 60, fromNewest: 1, mark: 30 },
      },
      [HOME]: { name: "Home base", count: 60, seed: 40 },
    },
    { queryDelayMs: 80 },
  ),
);
const CASES = {
  "inline-cold": [S1, "inline"],
  "inline-warm": [S1, "warm"],
  "deep-cold": [S2, "deep"],
  "reply-cold": [S3, "reply"],
};

async function jump(page, perf, app, name, [channel, mark]) {
  const { id, token } = app.corpus.marks[channel][mark];
  await perf.openChannel(HOME);
  const dialog = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  await expect(dialog).not.toHaveAttribute("data-starting-style");
  await dialog.evaluate((node) =>
    Promise.all(
      node
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished),
    ),
  );
  await dialog.getByRole("combobox", { name: "Search Buzz" }).fill(token);
  const option = `[role="option"][id$="-${id}"]`;
  await expect(dialog.locator(option)).toBeVisible();
  const run = await perf.click(name, option);
  const thread = placement(frames(run.session, "thread"), id, run.from);
  const main = frames(run.session, "timeline", channel);
  const inline = placement(main, id, run.from);
  const surface = thread.inViewAtEnd
    ? "thread"
    : inline.inViewAtEnd
      ? "inline"
      : "none";
  const final = main.findLast((r) => !r.absent);
  const row = final?.rows.find((r) => r.id === id);
  // Absent frames (another channel) still carry focus and palette state.
  return {
    ...run,
    surface,
    focusedMs: focused(
      main,
      id,
      surface === "thread" ? "thread" : "timeline",
      run.from,
    ),
    displacementPx: (surface === "thread" ? thread : inline).displacementPx,
    paletteShown: main.findLast((r) => r.at <= run.from)?.palette === 1,
    paletteGoneMs:
      main.find((r) => r.at > run.from && !r.palette)?.at - run.from,
    // The reveal had to move: the target lies above the bottom-pinned view.
    aboveBottom: !!row && row.bottom <= final.bottomGap,
  };
}

test("search jump: inline cold, inline warm, deep and reply", async ({
  page,
  app,
  perf,
}) => {
  await perf.setup(HOME);
  const cases = {};
  for (const [name, target] of Object.entries(CASES)) {
    const c = await jump(page, perf, app, name, target);
    perf.require(
      `${name}: palette open at the click, then closed`,
      c.paletteShown && c.paletteGoneMs > 0,
    );
    perf.require(`${name}: target focused`, c.focusedMs != null);
    cases[name] = c;
  }
  for (const name of ["inline-cold", "inline-warm"])
    perf.require(
      `${name}: inline, above the bottom view`,
      cases[name].surface === "inline" && cases[name].aboveBottom,
    );
  perf.require("deep-cold: revealed", cases["deep-cold"].surface !== "none");
  perf.require(
    "reply-cold: Thread panel",
    cases["reply-cold"].surface === "thread",
  );
  const each = (key, names = Object.keys(CASES)) =>
    Object.fromEntries(
      names.map((name) => [`${name}.${key}`, cases[name][key]]),
    );
  await perf.result("search-jump", "sequence", {
    targets: each("focusedMs", ["inline-cold", "reply-cold"]),
    defects: {
      "inline-cold.displacementPx": cases["inline-cold"].displacementPx,
    },
    guards: { ...each("scriptMs"), ...each("settleMs") },
    work: {
      // Bound by the palette's close, or the same path as a target.
      ...each("focusedMs", ["inline-warm", "deep-cold"]),
      ...each("paletteGoneMs"),
      "deep-cold.inThread": cases["deep-cold"].surface === "thread" ? 1 : 0,
    },
  });
});
