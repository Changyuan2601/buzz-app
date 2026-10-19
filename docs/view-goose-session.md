# View a Goose session started by Buzz

Buzz runs Goose through ACP. Goose saves those conversations locally with
`session_type = 'acp'`. The ordinary `goose session list` command shows only user
and scheduled sessions, so Buzz sessions do not appear there. The ACP type alone
does not identify Buzz: other ACP clients use it too.

Buzz sets `GOOSE_PATH_ROOT` only for its Goose child processes to
`~/Library/Application Support/Buzz/goose-home` on macOS, or
`${XDG_DATA_HOME:-~/.local/share}/buzz/goose-home` on Linux. Its database is
`<goose-home>/data/sessions/sessions.db`; normal terminal Goose commands keep their
default database. Buzz links `config/` to the user's Goose config directory
(`$GOOSE_PATH_ROOT/config` when already configured, otherwise
`${XDG_CONFIG_HOME:-~/.config}/goose`). Provider settings, file-based secrets and
the existing Goose keyring service remain shared; data and state stay private.
A conflicting Buzz config directory stops setup rather than being replaced.

Buzz's Activity reader also reads older Buzz conversations from the user's database,
filtering by the agent and conversation recorded in their prompts. Old rows are
left in place; new sessions are always created in Buzz's database.
Goose IDs can repeat across databases. Activity uses a `legacy:` prefix internally
to distinguish older sessions; remove that prefix when passing an ID to Goose CLI.

## Find the session

List recent ACP sessions in Buzz's database:

```sh
db="$HOME/Library/Application Support/Buzz/goose-home/data/sessions/sessions.db"
sqlite3 -readonly "$db" \
  "SELECT id, created_at, provider_name,
          json_extract(model_config_json, '$.model_name')
   FROM sessions WHERE session_type = 'acp'
   ORDER BY created_at DESC LIMIT 20;"
```

To match a particular Buzz message, copy its 64-character event ID from the
`id=` parameter of its `buzz://message` link and search the saved conversation:

```sh
sqlite3 -readonly "$db" \
  "SELECT DISTINCT s.id, s.created_at, s.provider_name,
          json_extract(s.model_config_json, '$.model_name')
   FROM sessions AS s JOIN messages AS m ON m.session_id = s.id
   WHERE s.session_type = 'acp'
     AND m.content_json LIKE '%<buzz-message-id>%';"
```

Replace `<buzz-message-id>` with the event ID. Check the returned time, provider,
and model against the Buzz thread before exporting.

## Export and open HTML

HTML export ([goose#11977](https://github.com/aaif-goose/goose/pull/11977)) is
merged to Goose `main` but is not in v1.53.0 or earlier releases. Until your
installed Goose includes it, build the binary from Goose `main` and use it for
export:

```sh
/path/to/goose session export \
  --session-id <goose-session-id> --format html -o session.html
open session.html # macOS; otherwise open the file in a browser
```

The HTML file contains the session conversation and tool activity. Keep it local
unless you intend to share that content.

See [Goose session management](https://raw.githubusercontent.com/aaif-goose/goose/refs/heads/main/documentation/docs/guides/sessions/session-management.md)
for general session storage and export documentation.
