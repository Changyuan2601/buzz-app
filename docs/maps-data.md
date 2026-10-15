# Local Maps datasets

Maps continues to use the channel composer and signed, correlated agent replies.
For Square data, an agent publishes a dataset ID rather than putting seller rows
in its context or in a channel message. The renderer streams all matching points
from Snowflake, verifies the completion count, and renders a clustered GeoJSON
source. An interrupted query is an error, never a successful partial result.

The local service is opt-in: set `BUZZ_MAP_DATA=1`, `BUZZ_DEV_VIEWER` to the local
viewer public key, and `BUZZ_RELAY_URL` to that viewer's community when starting
Vite. It accepts only loopback, same-origin requests in that configured partition.
The service uses the existing Wondershop Snowflake SDK/configuration and viewer
SSO. `WONDERSHOP_DIR` can select that checkout. It is a local development tool,
not a hosted authentication or per-channel authorization boundary.

The Maps prompt supplies the current agent-tool command:

```sh
node scripts/maps/publish.mjs --scope 'https://community:VIEWER_PUBKEY' \
  --channel CHANNEL_ID --request-id REQUEST_ID \
  --bbox west,south,east,north --category hair_salon --require-address
```

Run it inside the agent's inherited Buzz relay/identity environment. It preserves
the incoming channel and optional `--reply-to` thread. Stdout contains only
publication status and the dataset ID. The query runs when the viewer opens the
map; publication does not attest that Snowflake has finished loading.

`.buzz/maps.sqlite` stores query references, personal view metadata, and
user-authored retailer notes keyed by an opaque source location ID. It never
stores seller names, addresses, point records or query-result snapshots. Saved
views are scoped to community, viewer and channel; move-end saves the viewport.
Existing signed map history still restores small inline geometry and the latest
dataset references. Saved personal viewport takes precedence over historical
agent viewport changes when reopening a channel.

ROSTER detail cards offer a personal note field and explicit Save action. Notes
are scoped to community, viewer and channel and survive fresh dataset queries.
Clearing the field and saving clears the note. Concurrent saves use revisions:
a stale save retains the draft and asks the viewer to load the latest saved note
before replacing it. Notes are not automatically sent to chat or agent context;
“Add to message” inserts a name-only inline business pill carrying the chosen
address and coordinates, never the personal note. Inline markers
without a stable source ID do not have persistent notes.

`scripts/maps/schema.sql` uses SQLite-compatible SQL for a future App Kit D1
migration. D1 is restricted to permitted metadata (DSL-2 ceiling). Restricted
seller data must remain in Snowflake and be fetched under each viewer's access.
User-authored notes need their own data-classification and authorization review
before hosting; compatible SQL is not approval to put arbitrary notes in D1.
The current adapter uses one explicitly configured local ROSTER view; it is not
ready for deployment. A hosted adapter must use App Kit SSO, viewer-specific
Snowflake authorization and channel access checks before returning data.

This first slice does not provide cross-machine dataset availability, shared
viewport synchronization, dataset management controls, or spatial tile serving.
Packaged desktops do not include the local Vite data service; dataset references
show an availability message there. Use the development server for this slice.
No SQL result limit or chat token window limits the query; the browser still
holds the rendered geometry in memory. Very large datasets will need viewport
queries or vector tiles before that memory cost becomes practical.

The renderer streams seller names and receipt addresses into hover previews and
a pinned selection card. These fields are not automatically written to map
metadata, chat replies or agent prompts. “Add to message” inserts the selected
business at the caret through the shared composer's `insertResource` command.
The pill shows its name and retains a snapshot of its address, coordinates,
category and opaque source ID in a supported Buzz channel link. Sending remains
the user's action; the reference is neither a recipient nor an access grant.
Maps supplies explicitly attached business references as data to its agent,
without exposing bulk dataset rows or personal notes. Clicking a sent reference
in that channel's Maps view centers the existing map. Other clients retain a
normal link back to the channel.

The local native development server can pin `BUZZ_MAP_VIEWER` independently of
the browser broker's `BUZZ_DEV_VIEWER`, preserving native identity handling.
`BUZZ_MAP_DATA=1` opts in to this loopback-only service. Layer visibility is
temporary; saved views retain viewport and dataset references.
