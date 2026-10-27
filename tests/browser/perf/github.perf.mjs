import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { test as base, expect } from "../playwright-test.mjs";
import { build, preview } from "../vite-server.mjs";
import { loafBlocking } from "./blocking.mjs";
import { observeGitHub } from "./github-observer.mjs";
import { responses } from "./github-responses.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entry = "tests/browser/perf/github.html";
const test = base.extend({
  githubBuild: [
    async ({ browserName }, use) => {
      const directory = await mkdtemp(join(tmpdir(), "buzz-github-perf-"));
      let server;
      try {
        const config = {
          root,
          configFile: false,
          envFile: false,
          mode: "production",
          logLevel: "error",
          plugins: [react()],
          build: {
            outDir: join(directory, "dist"),
            rollupOptions: { input: join(root, entry) },
          },
          preview: { host: "127.0.0.1", port: 0 },
        };
        const start = performance.now();
        await build(config);
        const buildMs = performance.now() - start;
        server = await preview(config);
        await use({
          browserName,
          url: `${server.resolvedUrls.local[0]}${entry}`,
          buildMs,
          commit: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
          dirty: !!execFileSync("git", ["status", "--porcelain"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
        });
      } finally {
        if (server)
          await new Promise((resolve) => server.httpServer.close(resolve));
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
});
const counters = {
  scriptMs: "ScriptDuration",
  layoutMs: "LayoutDuration",
  styleMs: "RecalcStyleDuration",
  taskMs: "TaskDuration",
};
async function readCounters(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(
    Object.entries(counters).map(([key, name]) => {
      const value = metrics.find((metric) => metric.name === name)?.value;
      if (!Number.isFinite(value))
        throw new Error(`Missing browser counter ${name}`);
      return [key, value * 1000];
    }),
  );
}
async function open(page, cdp, signed) {
  const button = await page.locator("#open-pr").boundingBox();
  if (!button) throw new Error("Missing PR opener");
  const observer = await page.evaluateHandle(observeGitHub, { signed });
  try {
    const before = await readCounters(cdp);
    for (const type of ["mousePressed", "mouseReleased"])
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x: button.x + button.width / 2,
        y: button.y + button.height / 2,
        button: "left",
        clickCount: 1,
      });
    await observer.evaluate((recording) => recording.done());
    const after = await readCounters(cdp);
    const recording = await observer.evaluate((recording) =>
      recording.result(),
    );
    recording.longAnimationFrames = await observer.evaluate((recording) =>
      recording.longFrames(),
    );
    const metrics = Object.fromEntries(
      Object.keys(counters).map((key) => [key, after[key] - before[key]]),
    );
    for (const name of [
      "completeMs",
      "descriptionMs",
      "detailsMs",
      "checklistMs",
    ])
      if (recording[name] !== undefined) metrics[name] = recording[name];
    metrics.loafBlockingMs = loafBlocking(recording);
    if (recording.requests.length)
      metrics.finalRenderTailMs =
        recording.completeMs -
        Math.max(...recording.requests.map((request) => request.responseMs));
    return { metrics, recording };
  } finally {
    await observer.evaluate((recording) => recording.stop());
    await observer.dispose();
  }
}

for (const transport of ["signed", "public"])
  for (const latency of ["immediate", "delayed"])
    for (const lifecycle of ["cold", "reopen"]) {
      for (
        let repeat = 1;
        repeat <= Number(process.env.PERF_REPEAT ?? 1);
        repeat++
      ) {
        test(`github-pr-${transport}-${latency}-${lifecycle} sample ${repeat}`, async ({
          page,
          browser,
          githubBuild,
        }, testInfo) => {
          const signed = transport === "signed";
          const delayMs = latency === "immediate" ? 0 : signed ? 1354 : 450;
          const requests = [];
          await page.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            const response = responses[url.pathname];
            if (!response) {
              if (
                url.origin === new URL(githubBuild.url).origin &&
                !url.pathname.startsWith("/__github/")
              )
                return route.continue();
              throw new Error(`Unexpected external request: ${url}`);
            }
            if (url.pathname === "/__github/graphql") {
              const request = route.request().postDataJSON();
              expect(request.variables).toEqual({
                owner: "sample",
                name: "project",
                number: 9,
              });
              expect(request.query).toContain("statusCheckRollup");
            }
            const body = JSON.stringify(response);
            const record = {
              path: url.pathname,
              requestedDelayMs: delayMs,
              bytes: Buffer.byteLength(body),
              status: 200,
            };
            requests.push(record);
            const start = performance.now();
            if (delayMs)
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            record.actualDelayMs = performance.now() - start;
            await route.fulfill({
              body,
              contentType: "application/json",
              headers: {
                "Access-Control-Allow-Origin": "*",
                "Timing-Allow-Origin": "*",
                "Cache-Control": "no-store",
              },
            });
          });
          await page.goto(`${githubBuild.url}?transport=${transport}`);
          await expect(page.locator("#open-pr")).toBeVisible();
          await page.evaluate(() => document.fonts.ready);
          expect(requests).toHaveLength(0);
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Performance.enable");
          await cdp.send("Emulation.setCPUThrottlingRate", {
            rate: Number(process.env.PERF_CPU),
          });
          try {
            if (lifecycle === "reopen") {
              const preparation = await open(page, cdp, signed);
              expect(preparation.recording.error).toBeUndefined();
              await page
                .getByRole("button", { name: "Close GitHub panel" })
                .click();
              await expect(
                page.getByRole("complementary", {
                  name: "GitHub",
                  exact: true,
                }),
              ).toHaveCount(0);
            }
            const before = requests.length;
            const sample = await open(page, cdp, signed);
            sample.work = {
              transport,
              latency,
              lifecycle,
              requests: requests.slice(before),
              preparationRequests: before,
            };
            sample.state = {
              ...githubBuild,
              url: undefined,
              scope:
                "production GitHubPanel + PanelCard; external GitHub mocked; other plugins absent",
              browser: browser.version(),
              node: process.version,
              viewport: page.viewportSize(),
            };
            sample.metrics.requestCount = requests.length - before;
            sample.metrics.responseBytes = sample.work.requests.reduce(
              (total, request) => total + request.bytes,
              0,
            );
            await testInfo.attach("perf-sample", {
              body: JSON.stringify(sample),
              contentType: "application/json",
            });
            await page.screenshot({ path: testInfo.outputPath("github.png") });
            expect(sample.recording.error).toBeUndefined();
            if (lifecycle === "cold")
              expect(sample.metrics.requestCount).toBeGreaterThan(0);
            expect(sample.recording.requests).toHaveLength(
              sample.metrics.requestCount,
            );
            for (const request of sample.recording.requests)
              expect(request.responseMs).toBeGreaterThanOrEqual(
                request.startMs,
              );
            for (const value of Object.values(sample.metrics))
              expect(value).toBeGreaterThanOrEqual(0);
            const checklist = page.getByRole("list", {
              name: "Pull request checklist",
            });
            await checklist
              .getByRole("button", {
                name: "1 failed · 1 running · 1 passed",
                exact: true,
              })
              .click();
            await expect(
              checklist.getByRole("link", { name: "e2e", exact: true }),
            ).toHaveAttribute(
              "href",
              "https://github.com/sample/project/actions/runs/1",
            );
          } finally {
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
            await cdp.detach();
          }
        });
      }
    }
