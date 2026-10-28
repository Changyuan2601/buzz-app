// micromark's browser entity decoder creates an element when it loads, and a
// worker has no DOM. Decoding a named reference here throws instead, so those
// bodies are left to the main thread rather than decoded differently.
(globalThis as { document?: unknown }).document ??= {
  createElement: () => ({
    set innerHTML(_: string) {
      throw new Error("No DOM in this worker");
    },
  }),
};
