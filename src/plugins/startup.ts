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

export function afterFirstView<T>(load: () => Promise<T>) {
  return () =>
    presented
      // Let the destination's own follow-up work run before plugin code.
      .then(() => new Promise((resolve) => setTimeout(resolve)))
      .then(load);
}
