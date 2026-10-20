//! Agent token client: each local agent's NIP-FI grant and the agent assertion
//! JWTs it mints. The native app holds both; nothing crosses IPC.

pub(crate) mod grant;
