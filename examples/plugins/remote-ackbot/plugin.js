// Prebuilt API v1 module: a hosted Agents type whose provider is the ack bot
// server beside this file (server.mjs), on this computer. The provider holds
// each agent's key and runs it; this plugin only forwards the app's `remote`
// steps to it, and its Status tab reads and saves the provider's settings.
export const inject = ["react", "agents"];

const SERVER = "http://127.0.0.1:8787";

async function call(path, method, body, signal) {
  let response;
  try {
    response = await fetch(`${SERVER}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      `The ack bot server is not reachable at ${SERVER}. Start it with: node examples/plugins/remote-ackbot/server.mjs`,
    );
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      result.error ?? `The ack bot server answered ${response.status}`,
    );
  return result;
}

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;

  function Status({ agent }) {
    const [state, setState] = React.useState(undefined);
    const [reply, setReply] = React.useState("");
    const [error, setError] = React.useState("");
    React.useEffect(() => {
      const controller = new AbortController();
      call(`/agents/${agent.pubkey}`, "GET", undefined, controller.signal).then(
        (result) => {
          setState(result);
          setReply(result.reply);
        },
        (reason) => controller.signal.aborted || setError(reason.message),
      );
      return () => controller.abort();
    }, [agent.pubkey]);
    const saveReply = () => {
      setError("");
      call(`/agents/${agent.pubkey}/settings`, "POST", { reply }).then(
        (result) => setState((prior) => ({ ...prior, ...result })),
        (reason) => setError(reason.message),
      );
    };
    if (error && !state) return h("p", { role: "alert" }, error);
    if (!state) return h("p", null, "Asking the ack bot server…");
    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-2, 8px)" } },
      h(
        "p",
        null,
        state.active
          ? `Running on ${SERVER}. It has answered ${state.replies} mention${state.replies === 1 ? "" : "s"}.`
          : "Made, but not set up yet.",
      ),
      h(
        "label",
        { style: { display: "grid", gap: 4 } },
        "Reply",
        h("input", {
          value: reply,
          onChange: (event) => setReply(event.target.value),
        }),
      ),
      h(
        "button",
        { type: "button", onClick: saveReply, disabled: reply === state.reply },
        "Save reply",
      ),
      error && h("p", { role: "alert" }, error),
    );
  }

  ctx.agents.register({
    id: "ackbot",
    title: "Remote ack bot",
    description: `Replies to your mentions from a server on this computer (${SERVER}). For trying hosted agents.`,
    defaults: () => ({ config: {} }),
    summary: () => "Hosted on this computer",
    tabs: [{ id: "status", title: "Status", component: Status }],
    remote: {
      provision: ({ name, community, signal }) =>
        call("/agents", "POST", { name, community }, signal),
      activate: async ({ pubkey, name, community, auth, signal }) => {
        await call(
          `/agents/${pubkey}/activate`,
          "POST",
          { name, community, auth },
          signal,
        );
      },
      profile: async ({ pubkey, name, picture, signal }) => {
        await call(
          `/agents/${pubkey}/profile`,
          "POST",
          { name, picture },
          signal,
        );
      },
      remove: async ({ pubkey, signal }) => {
        await call(`/agents/${pubkey}`, "DELETE", undefined, signal);
      },
    },
  });
}
