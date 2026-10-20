//! Host side of the bundled Mesh plugin (`src/bundled/mesh-compute/compute`):
//! lends it the signed-in identity and the authenticated relay client.
use crate::{identity, relay};
use buzz_mesh_compute::desktop::host::{AppIdentity, BoxFuture, EventTemplate, Identity};

pub(crate) use buzz_mesh_compute::desktop::MeshHost;

struct AppHost(identity::IdentityHost);

impl AppIdentity for AppHost {
    fn viewer(&self) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(self.0.viewer())
    }
    /// Signs Mesh member status only; the plugin gets no general signing.
    fn sign(&self, event: EventTemplate) -> BoxFuture<'_, Result<serde_json::Value, String>> {
        if u64::from(event.kind) != buzz_mesh_compute::discovery_types::MESH_STATUS_KIND {
            return Box::pin(async { Err("Mesh may only sign its status event".into()) });
        }
        Box::pin(self.0.sign(identity::EventTemplate {
            kind: event.kind,
            created_at: event.created_at,
            tags: event.tags,
            content: event.content,
        }))
    }
    fn relay_read<'a>(
        &'a self,
        community: &'a str,
        filter: Option<serde_json::Value>,
    ) -> BoxFuture<'a, Result<serde_json::Value, String>> {
        Box::pin(relay::mesh_read(&self.0, community, filter))
    }
    fn relay_publish<'a>(
        &'a self,
        community: &'a str,
        event: serde_json::Value,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(relay::mesh_publish(&self.0, community, event))
    }
}

pub(crate) fn identity(host: identity::IdentityHost) -> Identity {
    std::sync::Arc::new(AppHost(host))
}
