//! Native Mesh lifecycle owner. The application retains credentials and relay authority.
//!
//! Initial integration checkpoint: no runtime is launched until the SDK adapter lands.

#[cfg(feature = "mesh")]
pub mod config;
#[cfg(feature = "mesh")]
pub mod identity;
#[cfg(feature = "mesh")]
pub mod lifecycle;
#[cfg(feature = "mesh")]
mod transport_policy;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    pub reason: &'static str,
}

/// Explicitly unavailable during bring-up; compilation is not runtime readiness.
pub fn status() -> Status {
    Status {
        available: false,
        reason: "Mesh runtime integration is not complete",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn scaffold_never_claims_runtime_readiness() {
        assert!(!super::status().available);
    }
}

#[cfg(feature = "mesh")]
pub mod discovery;
#[cfg(feature = "mesh")]
pub mod discovery_query;
#[cfg(feature = "mesh")]
pub mod discovery_types;

#[cfg(feature = "mesh")]
pub mod inventory;
pub mod startup_log;

#[cfg(feature = "mesh")]
pub mod roster;

#[cfg(feature = "mesh")]
pub mod publication;

#[cfg(feature = "mesh")]
pub mod catalog;
#[cfg(feature = "mesh")]
mod progress;
