# Remote ack bot

A hosted Agents type with a pretend provider on this computer. It exercises
the `remote` steps an agent type can supply instead of `run`. The server
(`server.mjs`) holds each agent's key and takes the owner's NIP-OA
attestation. It publishes the agent's profile and answers each of its owner's
mentions with "ack". The plugin (`plugin.js`) passes the app's steps on to the
server, and its **Status** tab reads and saves the provider's reply text.

1. From the repository root, start the server: `node examples/plugins/remote-ackbot/server.mjs`.
   It listens on `127.0.0.1:8787` and keeps its agents, with their keys in plain
   text, in `remote-ackbot.json` beside it. Use it for testing only.
2. Run the desktop app in development (`bin/just desktop`). Release builds' content
   security policy blocks the plugin's requests to `http://127.0.0.1`.
3. Go to Settings → Plugins → **Load from folder**, choose this folder, install
   **Remote ack bot** and enable it.
4. In Agents, choose **New agent**, pick **Remote ack bot (hosted)**, name it,
   then choose **Create and set up**. The app asks the server for the agent's key,
   signs your attestation for it, and lists the agent in your agent records.
5. Add the agent to a channel and mention it. Within a few seconds it replies "ack".

What to check along the way:

- **Interrupted setup.** Start the server with `FAIL_ACTIVATE=1`, and its first
  activation fails. The new agent then shows **Setup unfinished**. Choose
  **Finish setup** to resume without making a second agent.
- **Other devices.** On another device signed in as you, the agent appears as hosted
  if this plugin is installed there. Otherwise it shows as **On another device**.
- **Rename, picture and Delete.** These go through the server. Delete also removes
  the agent from its channels and archives it.
