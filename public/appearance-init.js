// Parser-blocking, same-origin bootstrap: no inline-script CSP exception required.
// Keep key/fallback aligned with shared/theme/service.ts (covered by service.test.ts).
(() => {
  let mode =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  try {
    const preference = localStorage.getItem("buzz-appearance.v1");
    if (preference === "light" || preference === "dark") mode = preference;
  } catch {
    // Storage may be denied; the system palette still opens safely.
  }
  document.documentElement.dataset.colorMode = mode;
  let accent = "chartreuse";
  try {
    const accents = [
      "gray",
      "chartreuse",
      "flame",
      "magenta",
      "iris",
      "cobalt",
      "jade",
    ];
    let value = localStorage.getItem("buzz-accent.v1");
    if (value === null) {
      // The former bubble color carries over; its old "Default" does not.
      const legacy = {
        blue: "cobalt",
        cyan: "cobalt",
        indigo: "cobalt",
        green: "jade",
        orange: "flame",
        pink: "magenta",
        red: "magenta",
        lilac: "iris",
        purple: "iris",
      };
      value = legacy[localStorage.getItem("buzz-bubble-color.v1")] ?? null;
    }
    if (accents.includes(value)) accent = value;
  } catch {
    /* The default accent remains usable without storage. */
  }
  document.documentElement.dataset.accent = accent;
  let level = "touch";
  try {
    const value = localStorage.getItem("buzz-color-level.v1");
    if (["neutral", "touch", "more", "full"].includes(value)) level = value;
  } catch {
    /* The default color amount remains usable without storage. */
  }
  document.documentElement.dataset.colorLevel = level;
  let scale = 1;
  try {
    const value = Number(localStorage.getItem("buzz-font-scale.v1"));
    if (Number.isFinite(value) && value >= 0.8 && value <= 2)
      scale = Math.round(value * 10) / 10;
  } catch {
    /* Text remains readable when storage is unavailable. */
  }
  document.documentElement.style.setProperty(
    "--buzz-text-scale",
    String(scale),
  );
})();
