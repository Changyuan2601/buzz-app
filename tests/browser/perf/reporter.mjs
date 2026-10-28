import { writeFileSync } from "node:fs";
import { cpus, loadavg, platform, arch } from "node:os";

export default class Reporter {
  runs = [];
  errors = [];
  onBegin() {
    this.startedAt = new Date().toISOString();
    this.load = loadavg();
  }
  onError(error) {
    this.errors.push(error.message);
  }
  onTestEnd(test, result) {
    const attachment = result.attachments.find((a) => a.name === "perf-sample");
    this.runs.push({
      scenario: test.title.replace(/ sample \d+$/, ""),
      status: result.status,
      executionMs: result.duration,
      errors: result.errors.map((error) => error.message),
      sample: attachment ? JSON.parse(attachment.body.toString()) : null,
      evidence: result.attachments.filter((a) => a.path).map((a) => a.path),
    });
  }
  onEnd(result) {
    const missing = this.runs.filter(
      (run) => run.status === "passed" && !run.sample,
    );
    if (missing.length)
      this.errors.push(
        `Missing performance samples: ${missing.map((run) => run.scenario).join(", ")}`,
      );
    const status =
      result.status === "passed" && (missing.length || !this.runs.length)
        ? "failed"
        : result.status;
    const summary = {};
    const outcomes = {};
    for (const run of this.runs.filter(
      (r) => r.status === "passed" && r.sample,
    )) {
      summary[run.scenario] ??= {};
      const group = summary[run.scenario];
      if (run.sample.outcome) {
        outcomes[run.scenario] ??= { measured: 0, correct: 0, failures: {} };
        const counts = outcomes[run.scenario];
        counts.measured++;
        counts.correct += run.sample.metrics.workflowCorrect;
        for (const [key, value] of Object.entries(run.sample.outcome))
          if (key === "unexpectedPublications" ? value > 0 : !value)
            counts.failures[key] = (counts.failures[key] ?? 0) + 1;
      }
      for (const [key, value] of Object.entries(run.sample.metrics)) {
        if (!Number.isFinite(value))
          throw new Error(`Non-finite metric: ${key}`);
        group[key] ??= [];
        group[key].push(value);
      }
    }
    for (const group of Object.values(summary)) {
      for (const [key, values] of Object.entries(group)) {
        values.sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        group[key] = {
          n: values.length,
          median:
            values.length % 2
              ? values[middle]
              : (values[middle - 1] + values[middle]) / 2,
          min: values[0],
          max: values.at(-1),
        };
      }
    }
    writeFileSync(
      process.env.PERF_OUT,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status,
          startedAt: this.startedAt,
          durationMs: result.duration,
          settings: {
            scenario: process.env.PERF_SCENARIO,
            repeat: Number(process.env.PERF_REPEAT),
            cpu: Number(process.env.PERF_CPU),
            browser: process.env.PERF_BROWSER ?? "chromium",
            ...(process.env.PERF_BROWSER === "webkit" &&
            process.platform === "linux"
              ? {
                  webkitGstAllowPlaybackOfInvisibleVideos:
                    process.env.WEBKIT_GST_ALLOW_PLAYBACK_OF_INVISIBLE_VIDEOS ??
                    null,
                }
              : {}),
            inputIntervalMs: Number(process.env.PERF_INTERVAL ?? 40),
            viewport: { width: 1440, height: 950 },
          },
          host: {
            platform: platform(),
            arch: arch(),
            cpu: cpus()[0]?.model,
            loadAtStart: this.load,
            loadAtEnd: loadavg(),
          },
          evidenceDir: process.env.PERF_RUN_DIR,
          runs: this.runs,
          errors: this.errors,
          summary,
          outcomes,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Results written to ${process.env.PERF_OUT}`);
    for (const [name, counts] of Object.entries(outcomes))
      console.log(
        `${name}: ${counts.correct}/${counts.measured} correct workflows (measurement-only, no speed threshold)`,
      );
    return { status };
  }
}
