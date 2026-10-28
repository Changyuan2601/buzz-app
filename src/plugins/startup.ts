// Bundled plugins with nothing in the first view load after the app presents
// it, so their code and activation stay off the startup path. Navigation
// waits only for the plugin that owns the destination, never for these.
let present: () => void = () => {};
const presented = new Promise<void>((resolve) => {
  present = resolve;
});

/** Called once the window shows its first destination (or a terminal state). */
export function markPresented() {
  present();
}

// The destination's own follow-up work, such as its first rows, runs first.
const idle = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === "function")
      requestIdleCallback(() => resolve(), { timeout: 1000 });
    else setTimeout(resolve);
  });

export function afterFirstView<T>(load: () => Promise<T>) {
  return () => presented.then(idle).then(load);
}
