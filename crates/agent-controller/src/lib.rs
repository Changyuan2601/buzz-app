//! Local configuration and process ownership; never tied to a page or relay session.
//! No legacy desktop dependency, implicit identity creation, or credential projection.
mod agent_defaults;
mod app_agent;
mod bundle;
mod community;
mod config;
mod harness_policy;
pub use community::CommunityResolution;
pub use harness_policy::{
    AuthenticationPolicy, ConfigurationMode, EffortDiscovery, HarnessConfigurationPolicy,
    ModelRequirement, ProviderPolicy, SelectorEnvironment,
};
pub mod connection;
mod create;
mod credentials;
mod defaults;
mod harness_presets;
mod import;
pub mod logs;
mod ownership;
pub mod pi;
mod process;
mod profile;
mod restart;
mod runtime;
mod secret;
pub mod security;
mod skills;
mod store;
mod teams;
pub use teams::{
    BundleMember, MemberSnapshot, Memory, MemoryEntry, TeamCatalogEntry, TeamMeta, TeamSnapshot,
};
mod supervisor;
#[cfg(test)]
mod test_executable;
pub use supervisor::dispatch as dispatch_agent_supervisor;

pub use agent_defaults::{AgentDefaultsEdit, AgentDefaultsView};
pub use app_agent::{AppAgent, AppAgents, NewAppAgent, Published};
pub use bundle::RuntimeBundle;
pub use config::{AgentEdit, AgentView, ControlSnapshot, HarnessEdit, ProcessStatus};
pub use create::{CreationProfile, NewAgent};
pub use credentials::{PlatformCredentials, BUSY as CREDENTIALS_BUSY};
pub use defaults::{build_defaults, BuildDefaults};
pub use harness_presets::{harness_preset, harness_presets, HarnessPreset};
pub use import::{
    CloneSettings, CredentialedImport, ImportPreview, Imports, LegacySource, PreparedImport,
};
pub use restart::{RestartChange, RestartDiffEntry};
pub use runtime::path::{prepare_tools_path, tools_path, warm_tools_path};
pub use runtime::{
    check_owner, delete_local_agent_keys, installed, installed_npm_tool, managed_tool, Action,
    Controller, GooseModelContext, ModelContext,
};
pub use secret::{validate_snapshot_memory_envelope, Credentials, Secret};
pub use skills::ensure_buzz_cli_skill;
pub use store::{ParkedIdentity, Store};
type Result<T> = std::result::Result<T, String>;

mod mesh;
pub use mesh::{MeshLaunch, MeshRequest};
