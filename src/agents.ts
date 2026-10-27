// FOUNDATION: Startup of the page that runs agents. It has no screens.
import { createAgentsHost } from "./app/agents-host";
import { loadAgentStorage } from "./features/agents/state";

// Agent storage is read before the service, since its reads are synchronous.
void loadAgentStorage().finally(() => {
  const host = createAgentsHost();
  if (import.meta.hot)
    import.meta.hot.dispose(() => {
      void host.dispose().catch(console.error);
    });
});
