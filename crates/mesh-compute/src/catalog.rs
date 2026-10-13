//! Share-compute picker, adapting Buzz's curated ladder to the pinned SDK catalog.
use mesh_llm_host_runtime::models::{self, remote_catalog::RemoteCatalogModel};
use mesh_llm_system::{hardware, vram};
use serde::Serialize;

const CURATED_SMALL: &str = "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M";
const CURATED_MEDIUM: &str = "unsloth/Qwen3.5-9B-GGUF:Q4_K_M";
const CURATED_LARGE: &str = "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M";
const LEGACY_LARGE_XL: &str = "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL";

/// Rated-capacity boundary for the balanced Qwen3.5 9B tier.
const CURATED_MEDIUM_MIN_RATED_GB: u64 = 32;
/// Qwen3.8 27B is recommended for 64 GB-and-larger rated capacity classes,
/// leaving headroom for KV cache and runtime use (Buzz donor 639593bba).
const CURATED_LARGE_MIN_RATED_GB: u64 = 64;

/// Preserve the historical Buzz aliases at the native sharing boundary.
pub fn canonical_curated_model_id(model: &str) -> &str {
    match model.trim() {
        "Gemma-4-E4B-it-Q4_K_M" => CURATED_SMALL,
        "Qwen3.5-9B-Vision-Q4_K_M" => CURATED_MEDIUM,
        "Qwen3.8-27B-Q4_K_M" => "unsloth/Qwen3.8-27B-GGUF:Q4_K_M",
        "gemma-4-26B-A4B-it-UD-Q4_K_M" => "unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M",
        other => other,
    }
}

/// Older pickers persisted these recommendations without an explicit Auto mode.
pub fn is_legacy_recommendation(model: &str) -> bool {
    matches!(
        model,
        CURATED_SMALL | CURATED_MEDIUM | CURATED_LARGE | LEGACY_LARGE_XL
    )
}

/// Hardware-ranked models with cache evidence, not a claim of runtime readiness.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub gpu_name: Option<String>,
    pub vram_display: String,
    pub recommended: Option<String>,
    pub entries: Vec<Entry>,
}

/// One exact, downloadable model choice from the SDK's catalog.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub model: String,
    pub name: String,
    pub size: Option<String>,
    pub description: Option<String>,
    pub installed: bool,
    pub curated: bool,
    pub fit: &'static str,
}

/// Runs blocking hardware/cache/catalog I/O; callers must use a blocking task.
pub fn catalog() -> anyhow::Result<Catalog> {
    // The remote layer catalog enriches choices; it does not own Buzz's GGUF ladder.
    if let Err(error) = models::remote_catalog::ensure_catalog() {
        eprintln!("Mesh catalog metadata unavailable: {error}");
    }
    let survey = hardware::survey();
    let installed = models::scan_installed_models();
    Ok(build(
        survey.gpu_name,
        survey.vram_bytes,
        models::remote_catalog::loaded_models().unwrap_or_default(),
        |model| {
            installed
                .iter()
                .any(|cached| canonical_curated_model_id(cached) == model)
                || models::find_model_path(model).is_file()
        },
    ))
}

fn exact_quant(file: &str, quant: &str) -> bool {
    let file = file.to_ascii_uppercase();
    let quant = quant.to_ascii_uppercase();
    file.match_indices(&quant).any(|(offset, _)| {
        let prefix = &file[..offset];
        let suffix = &file[offset + quant.len()..];
        (prefix.is_empty() || prefix.ends_with(['-', '.', '_']))
            && !prefix.ends_with("UD-")
            && (suffix.is_empty() || suffix.starts_with(['-', '.']))
    })
}

fn fit(size: Option<&str>, memory: f64) -> &'static str {
    let gb = size.map(models::catalog::parse_size_gb).unwrap_or(0.0);
    if gb <= 0.0 || memory <= 0.0 {
        "unknown"
    } else if gb <= memory * 0.6 {
        "comfortable"
    } else if gb <= memory * 0.9 {
        "tight"
    } else if gb <= memory * 1.1 {
        "tradeoff"
    } else {
        "too_large"
    }
}
fn fit_rank(fit: &str) -> u8 {
    match fit {
        "comfortable" => 0,
        "tight" => 1,
        "tradeoff" => 2,
        "too_large" => 3,
        _ => 4,
    }
}
/// Device recommendation uses Buzz's hardware ladder, not remote catalog availability.
/// This performs only a local hardware survey; serving owns artifact acquisition.
pub fn recommended_model() -> String {
    recommendation_for_memory(hardware::survey().vram_bytes).to_owned()
}

fn recommendation_for_memory(bytes: u64) -> &'static str {
    match vram::rated_capacity_gb(bytes) {
        Some(gb) if gb >= CURATED_LARGE_MIN_RATED_GB => CURATED_LARGE,
        Some(gb) if gb >= CURATED_MEDIUM_MIN_RATED_GB => CURATED_MEDIUM,
        _ => CURATED_SMALL,
    }
}

fn build(
    gpu_name: Option<String>,
    bytes: u64,
    models: Vec<RemoteCatalogModel>,
    installed: impl Fn(&str) -> bool,
) -> Catalog {
    let recommendation = recommendation_for_memory(bytes);
    let mut entries: Vec<Entry> = models
        .iter()
        .filter(|model| {
            !models
                .iter()
                .any(|other| other.draft.as_deref() == Some(model.name.as_str()))
                || model.draft.is_some()
        })
        .map(|model| {
            // Curated choices preserve the donor's ingress refs; other choices use exact SDK refs.
            let curated = [CURATED_SMALL, CURATED_MEDIUM, CURATED_LARGE]
                .into_iter()
                .find(|reference| {
                    reference.split_once(':').is_some_and(|(repo, quant)| {
                        model.repo == repo && exact_quant(&model.source_file, quant)
                    })
                });
            let reference = curated
                .map(str::to_owned)
                .unwrap_or_else(|| model.exact_ref());
            Entry {
                installed: installed(&reference),
                model: reference,
                name: model.name.clone(),
                size: model.size.clone(),
                description: model.description.clone(),
                curated: curated.is_some(),
                fit: fit(model.size.as_deref(), bytes as f64 / 1e9),
            }
        })
        .collect();
    // Curated GGUF refs are resolved by Mesh at serving time, independently of
    // whether its remote layer-package catalog happens to list that quant.
    for reference in [CURATED_LARGE, CURATED_MEDIUM, CURATED_SMALL] {
        if !entries.iter().any(|entry| entry.model == reference) {
            entries.push(Entry {
                model: reference.into(),
                name: reference.into(),
                size: None,
                description: None,
                installed: installed(reference),
                curated: true,
                fit: "unknown",
            });
        }
    }
    let recommended = Some(recommendation.to_owned());
    entries.sort_by(|a, b| {
        (Some(&b.model) == recommended.as_ref())
            .cmp(&(Some(&a.model) == recommended.as_ref()))
            .then(b.curated.cmp(&a.curated))
            .then(fit_rank(a.fit).cmp(&fit_rank(b.fit)))
            .then(a.name.cmp(&b.name))
    });
    Catalog {
        gpu_name,
        vram_display: vram::format_rated_capacity(bytes),
        recommended,
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quantization_matches_do_not_confuse_dynamic_and_standard_files() {
        assert!(exact_quant("model-Q4_K_M.gguf", "Q4_K_M"));
        assert!(!exact_quant("model-UD-Q4_K_M.gguf", "Q4_K_M"));
        assert!(exact_quant("model-UD-Q4_K_XL.gguf", "UD-Q4_K_XL"));
        assert!(!exact_quant("model-Q4_K_M_EXTRA.gguf", "Q4_K_M"));
    }
    #[test]
    fn aliases_keep_the_donor_ingress_contract() {
        assert_eq!(
            canonical_curated_model_id("Gemma-4-E4B-it-Q4_K_M"),
            CURATED_SMALL
        );
        assert_eq!(
            canonical_curated_model_id("Qwen3.5-9B-Vision-Q4_K_M"),
            CURATED_MEDIUM
        );
        assert_eq!(
            canonical_curated_model_id("Qwen3.8-27B-Q4_K_M"),
            "unsloth/Qwen3.8-27B-GGUF:Q4_K_M"
        );
        assert_eq!(
            canonical_curated_model_id("gemma-4-26B-A4B-it-UD-Q4_K_M"),
            "unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M"
        );
        assert_eq!(canonical_curated_model_id(" custom-model "), "custom-model");
    }
    #[test]
    fn fit_preserves_donor_thresholds_and_unknown_is_not_a_fit() {
        assert_eq!(fit(Some("10GB"), 20.0), "comfortable");
        assert_eq!(fit(Some("10GB"), 12.0), "tight");
        assert_eq!(fit(Some("10GB"), 10.0), "tradeoff");
        assert_eq!(fit(Some("10GB"), 8.0), "too_large");
        assert_eq!(fit(None, 96.0), "unknown");
        assert_eq!(fit(Some("10GB"), 0.0), "unknown");
    }
    fn model(repo: &str, name: &str, size: &str) -> RemoteCatalogModel {
        RemoteCatalogModel {
            repo: repo.into(),
            name: name.into(),
            file: "weights-Q4_K_M.gguf".into(),
            source_file: "weights-Q4_K_M.gguf".into(),
            revision: None,
            size: Some(size.into()),
            description: None,
            draft: None,
            extra_files: vec![],
            mmproj: None,
        }
    }
    #[test]
    fn ladder_is_catalog_backed_and_keeps_exact_ids_installation_and_draft_policy() {
        let mut large = model("unsloth/Qwen3.8-27B-GGUF", "large", "17GB");
        large.source_file = "weights-UD-Q4_K_M.gguf".into();
        large.file = large.source_file.clone();
        large.draft = Some("draft".into());
        let models = vec![
            large,
            model("unsloth/Qwen3.5-9B-GGUF", "medium", "6GB"),
            model("unsloth/gemma-4-E4B-it-GGUF", "small", "3GB"),
            model("fixture/draft", "draft", "1GB"),
        ];
        for (bytes, recommended) in [
            (24_000_000_000, CURATED_SMALL),
            (32_000_000_000, CURATED_MEDIUM),
            (64_000_000_000, CURATED_LARGE),
            (96_000_000_000, CURATED_LARGE),
        ] {
            let catalog = build(None, bytes, models.clone(), |m| m == CURATED_SMALL);
            assert_eq!(catalog.recommended.as_deref(), Some(recommended));
            assert_eq!(catalog.entries[0].model, recommended);
            assert_eq!(catalog.entries.len(), 3);
            assert!(
                catalog
                    .entries
                    .iter()
                    .find(|e| e.model == CURATED_SMALL)
                    .unwrap()
                    .installed
            );
        }
        assert_eq!(
            build(None, 0, vec![], |_| false).recommended.as_deref(),
            Some(CURATED_SMALL)
        );
    }
    #[test]
    fn missing_layer_catalog_entry_does_not_change_the_gguf_ladder() {
        let catalog = build(
            None,
            128_000_000_000,
            vec![{
                let mut xl = model("unsloth/Qwen3.8-27B-GGUF", "large XL", "17GB");
                xl.source_file = "Qwen3.8-27B-UD-Q4_K_XL.gguf".into();
                xl.file = xl.source_file.clone();
                xl
            }],
            |reference| reference == CURATED_LARGE,
        );
        assert_eq!(catalog.recommended.as_deref(), Some(CURATED_LARGE));
        let recommended = &catalog.entries[0];
        assert_eq!(recommended.model, "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M");
        assert!(recommended.installed);
        assert!(recommended.size.is_none());
        assert_eq!(recommended.fit, "unknown");
    }
}

#[cfg(test)]
mod auto_tests {
    use super::*;
    #[test]
    fn auto_follows_the_hardware_ladder_without_catalog_or_cache_fallback() {
        assert_eq!(
            recommendation_for_memory(16 * 1024 * 1024 * 1024),
            CURATED_SMALL
        );
        assert_eq!(
            recommendation_for_memory(32 * 1024 * 1024 * 1024),
            CURATED_MEDIUM
        );
        assert_eq!(
            recommendation_for_memory(128 * 1024 * 1024 * 1024),
            CURATED_LARGE
        );
    }
}
