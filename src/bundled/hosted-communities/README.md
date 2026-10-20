# Hosted communities

Create and manage your own communities, hosted by Builderlab.

## Getting started

1. Go to **Settings → Communities → Hosted communities** and choose **Sign in with Builderlab**.
2. Choose **Create community**, then **Copy address**.
3. Join it with **Add a community** (+) in the community rail.

## How sign-in works

The desktop app signs in through the shared federated identity session, the same one Builderlab and protected communities use. Signing out here signs out of that shared session. The plugin never holds a token: the native host adds the session as `Authorization: Bearer` on the granted community and identity-link routes only. A 401 from one of those routes fails that call and leaves the session alone.

The account check that reported community deletion permission is not on the granted routes, so desktop builds hide deletion. The development broker keeps its existing account, identity-link and community behavior.
