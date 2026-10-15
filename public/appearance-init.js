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
  let bubbleColor = "neutral";
  try {
    let value = localStorage.getItem("buzz-bubble-color.v1");
    if (value === "cyan" || value === "indigo") value = "blue";
    else if (value === "red") value = "pink";
    else if (value === "purple") value = "lilac";
    if (["neutral", "blue", "green", "orange", "pink", "lilac"].includes(value))
      bubbleColor = value;
  } catch {
    /* Neutral remains usable without storage. */
  }
  document.documentElement.dataset.bubbleColor = bubbleColor;
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
