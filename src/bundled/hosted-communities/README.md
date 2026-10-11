# Hosted communities

Create and manage your own communities, hosted by Builderlab.

## Getting started

1. Go to **Settings → Communities → Hosted communities** and choose **Sign in with Builderlab**.
2. Choose **Create community**, then **Copy address**.
3. Join it with **Add a community** (+) in the community rail.
# Hosted Communities

The bundled `block.hosted-communities` plugin contributes Settings → Communities
→ Hosted communities. In packaged desktop and native development, it consumes
the shared [`federatedIdentity`](../../features/federated-identity/) service.
Builderlab settings and protected-community admission use the same native login;
this plugin owns no browser exchange or upstream session credential.

Native account display uses the public session snapshot, including optional email.
`native.ts` maps existing community and identity-link operations to relative API
requests, preserving the signed binding challenge and fencing results by session
revision and cancellation. Native grants come from the compiled
[deployment descriptor](../../../docs/configuration.md#federated-identity-build-input).
The shared host checks enabled artifact revision and live plugin registration.

API controls remain unavailable until the same-origin NIP-FA extension and API
authentication contract are agreed. The existing identity-link flow remains the
recovery destination for a binding mismatch; enabling its native API operations
is part of that deferred contract. No legacy session header is forwarded.

The supported Node development host retains `brokerApi` and its existing account,
identity-link, and community management behavior. This does not add browser FI
credential storage.

`index.test.tsx` covers host selection and shared public-session wiring.
`native.test.ts` covers relative requests, signed binding, cancellation, revision
changes, and optional email. `api.test.ts` and `HostedCommunities.test.tsx` retain
the operation and UI contracts. Native callback, persistence, and credential
lifecycle coverage belong to the shared native FI module; attended OS-store and
deployed adapter acceptance remain pending.
