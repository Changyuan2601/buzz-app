import { Context, Service } from "@deepseek-ai/cordis";
import { afterEach, expect, it } from "vitest";

// The installed Cordis bundle is patched to resolve available services
// without building an Error (patches/README.md); failures are unchanged.

class Counter extends Service {
  constructor(ctx: Context) {
    super(ctx, "counter");
  }
  read() {
    return 1;
  }
}

const NativeError = globalThis.Error;
afterEach(() => {
  globalThis.Error = NativeError;
});
/** Count errors constructed while `run` executes. */
function errorsDuring(run: () => void) {
  let made = 0;
  globalThis.Error = new Proxy(NativeError, {
    construct(target, args, newTarget) {
      made += 1;
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    run();
  } finally {
    globalThis.Error = NativeError;
  }
  return made;
}

async function plugged(inject: string[]) {
  const root = new Context();
  let ctx!: Context;
  root.plugin({
    inject,
    apply: (inner: Context) => {
      ctx = inner;
    },
  });
  await Promise.resolve();
  return { root, ctx: () => ctx };
}

function caught(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new NativeError("did not throw");
}

it("resolves an injected service without building an error", async () => {
  const { root, ctx } = await plugged(["counter"]);
  const service = new Counter(root);
  await Promise.resolve();
  let counter!: Counter;
  expect(
    errorsDuring(() => {
      counter = (ctx() as unknown as { counter: Counter }).counter;
    }),
  ).toBe(0);
  expect(counter.read()).toBe(1);
  expect(counter).not.toBe(service);
});

it("keeps the error and its stack for an unknown service", async () => {
  const { ctx } = await plugged([]);
  const error = caught(
    () => (ctx() as unknown as { missing: unknown }).missing,
  );
  expect(error.message).toBe('cannot get property "missing" without inject');
  const lines = String(error.stack).split("\n");
  expect(lines[0]).toBe('Error: cannot get property "missing" without inject');
  // The first frame is the caller, not Cordis.
  expect(lines[1]).toContain("cordis-lookup.test.ts");
});

it("keeps the inactive-context error", async () => {
  const { root, ctx } = await plugged(["counter"]);
  const provider = root.plugin(Counter);
  await new Promise((done) => setTimeout(done));
  const active = ctx();
  expect((active as unknown as { counter: Counter }).counter.read()).toBe(1);
  await provider.dispose();
  const error = caught(
    () => (active as unknown as { counter: Counter }).counter,
  );
  expect(error.message).toBe(
    'cannot get required service "counter" in inactive context',
  );
  expect(String(error.stack).split("\n")[1]).toContain("cordis-lookup.test.ts");
});

it("still hands internal/get listeners the lookup error", async () => {
  const { root, ctx } = await plugged(["counter"]);
  new Counter(root);
  await Promise.resolve();
  const seen: unknown[] = [];
  root.on(
    "internal/get" as never,
    ((_ctx: Context, prop: string, error: Error, next: () => unknown) => {
      seen.push(prop, error instanceof NativeError && error.message);
      return next();
    }) as never,
  );
  expect((ctx() as unknown as { counter: Counter }).counter.read()).toBe(1);
  expect(seen).toEqual([
    "counter",
    'cannot get property "counter" without inject',
  ]);
});
