// Which Apps Platform a Builderlab sign-in deploys to: the control plane of
// the same tenant, since its session is only valid there. Kept in step with
// `apps_control_plane` in crates/plugin-manager, which grants the plugin that
// origin.
const CONTROL_PLANES: Readonly<Record<string, string>> = {
  "https://app.builderlab.xyz": "https://compose-ctrl.public.builderlab.xyz",
  "https://app.builderlabstaging.xyz":
    "https://compose-ctrl.apps.builderlabstaging.xyz",
  "https://block.builderlab.xyz": "https://compose-ctrl.block.builderlab.xyz",
};

/** The control plane for the configured Builderlab URL, if it has one. */
export function controlPlane(
  value = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
) {
  try {
    return CONTROL_PLANES[new URL(value).origin];
  } catch {
    return undefined;
  }
}

/** Hosts that serve deployed apps, a subdomain each, per tenant. */
const APP_DOMAINS = [
  "apps.builderlab.xyz",
  "apps.public.builderlab.xyz",
  "apps.builderlabstaging.xyz",
  "apps.block.builderlab.xyz",
  "apps.test.blockstaging.build",
];

/** An app's name from its host, `<name>--<workspace>.<apps domain>`. */
export function appName(target: string) {
  try {
    return new URL(target).hostname.split(".")[0]?.split("--")[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Whether `target` is a deployed app's page. */
export function isAppUrl(target: string) {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    [...APP_DOMAINS, viewerAppDomain()].some(
      (domain) => domain && host.endsWith(`.${domain}`),
    )
  );
}

/** Trusted build configuration, paired with the configured login origin. Empty disables native SSO. */
export function viewerAppDomain(
  origin = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
  configured: string | undefined = import.meta.env
    .VITE_BUZZ_BUILDERLAB_APPS_DOMAIN,
): string {
  if (configured !== undefined) return configured;
  try {
    return new URL(origin).origin === "https://app.builderlab.xyz"
      ? "apps.builderlab.xyz"
      : "";
  } catch {
    return "";
  }
}

/** A credential is only exchanged for app hosts in the same configured tenant. */
export function isViewerTarget(
  target: string,
  origin = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
  domain = viewerAppDomain(origin),
) {
  try {
    const url = new URL(target);
    const login = new URL(origin);
    const label = domain && url.hostname.slice(0, -(domain.length + 1));
    return (
      login.protocol === "https:" &&
      !login.username &&
      !login.password &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      Boolean(
        domain &&
          url.port === "" &&
          url.hostname.endsWith(`.${domain}`) &&
          label &&
          !label.includes(".") &&
          label !== "login" &&
          label !== "health",
      )
    );
  } catch {
    return false;
  }
}
