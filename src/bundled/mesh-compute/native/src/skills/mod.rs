// Adapted from Goose at 69de89c5 (Apache-2.0); modified for the Mesh host.
// Origin, adaptation details and licence: ../developer/PROVENANCE.md and LICENSE.
//! Goose Skills filesystem core, extracted at the pin in ../developer/PROVENANCE.md.
//! Host-supplied roots replace Goose config/plugins/builtins. No relay skills.
mod arguments;
#[cfg(unix)]
mod supporting_files;
use anyhow::Result;
use arguments::apply_skill_arguments;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};
use tracing::warn;

#[derive(Clone, Debug)]
struct SourceEntry {
    name: String,
    description: String,
    content: String,
    path: String,
    supporting_files: Vec<String>,
    properties: HashMap<String, Value>,
}
#[derive(Debug, Deserialize)]
pub struct SkillFrontmatter {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: String,
    /// Free-form bag for caller-defined fields. Per the agentskills.io spec
    /// (<https://agentskills.io/specification#frontmatter>), arbitrary
    /// metadata lives in this nested mapping so it doesn't collide with
    /// reserved frontmatter fields.
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
}

fn loaded_skill_context(skill: &SourceEntry, content: &str) -> Result<String> {
    let title = format!("{} (skill)", skill.name);
    let mut output = format!(
        "# Loaded Skill: {title}\n\n{}\n\n## Content\n\n{}\n",
        skill.description, content
    );

    if !skill.supporting_files.is_empty() {
        let skill_dir = Path::new(&skill.path);
        output.push_str(&format!(
            "\n## Supporting Files\n\nSkill directory: {}\n\n\
             Relative paths in this skill resolve from the skill directory. \
             The shell tool runs in the session working directory, so use the \
             resolved path below or `cd` into the skill directory before running \
             supporting scripts.\n\n",
            skill.path
        ));
        for file in &skill.supporting_files {
            if let Ok(relative) = Path::new(file).strip_prefix(skill_dir) {
                let rel_str = relative.to_string_lossy().replace('\\', "/");
                let resolved_path = Path::new(file).to_string_lossy().replace('\\', "/");
                output.push_str(&format!(
                    "- {} → {} (load_skill(name: \"{}/{}\"))\n",
                    rel_str, resolved_path, skill.name, rel_str
                ));
            }
        }
    }

    Ok(output)
}

fn loaded_skill_context_with_args(skill: &SourceEntry, args: Option<&str>) -> Result<String> {
    let content = if let Some(args) = args {
        apply_skill_arguments(&skill.content, args, &skill_argument_names(skill))?
    } else {
        skill.content.clone()
    };

    loaded_skill_context(skill, &content)
}

fn skill_argument_names(skill: &SourceEntry) -> Vec<String> {
    skill
        .properties
        .get("arguments")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_skill_content(
    content: &str,
    path: &Path,
    _global: bool,
    _writable: bool,
) -> Option<SourceEntry> {
    let (metadata, body): (SkillFrontmatter, String) = match parse_frontmatter(content) {
        Ok(Some(parsed)) => parsed,
        Ok(None) => return None,
        Err(e) => {
            warn!("Failed to parse skill frontmatter: {}", e);
            return None;
        }
    };

    let name = match metadata.name.filter(|n| !n.is_empty()) {
        Some(n) => n,
        None => {
            warn!(
                "Skill at '{}' is missing a required 'name' in frontmatter, skipping",
                path.display()
            );
            return None;
        }
    };

    if name.contains('/') {
        warn!("Skill name '{}' contains '/', skipping", name);
        return None;
    }

    Some(SourceEntry {
        name,
        description: metadata.description,
        content: body,
        path: path.to_string_lossy().into_owned(),
        supporting_files: Vec::new(),
        properties: metadata.metadata,
    })
}

fn should_skip_dir(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some(".git") | Some(".hg") | Some(".svn")
    )
}

fn walk_files_recursively<F, G>(
    dir: &Path,
    visited_dirs: &mut HashSet<PathBuf>,
    should_descend: &mut G,
    visit_file: &mut F,
) where
    F: FnMut(&Path),
    G: FnMut(&Path) -> bool,
{
    let canonical_dir = match std::fs::canonicalize(dir) {
        Ok(path) => path,
        Err(_) => return,
    };

    if !visited_dirs.insert(canonical_dir) {
        return;
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if should_descend(&path) {
                walk_files_recursively(&path, visited_dirs, should_descend, visit_file);
            }
        } else if path.is_file() {
            visit_file(&path);
        }
    }
}

fn scan_skills_from_dir(
    dir: &Path,
    global: bool,
    writable: bool,
    preserve_path: bool,
    seen: &mut HashSet<String>,
) -> Vec<SourceEntry> {
    let mut skill_files = Vec::new();
    let mut visited_dirs = HashSet::new();

    walk_files_recursively(
        dir,
        &mut visited_dirs,
        &mut |path| !should_skip_dir(path),
        &mut |path| {
            if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
                skill_files.push(path.to_path_buf());
            }
        },
    );

    let mut sources = Vec::new();
    for skill_file in skill_files {
        let Some(skill_dir) = skill_file.parent() else {
            continue;
        };
        let registered_skill_dir = if preserve_path {
            skill_dir.to_path_buf()
        } else {
            let Ok(canonical_dir) = skill_dir.canonicalize() else {
                continue;
            };
            canonical_dir
        };
        let content = match std::fs::read_to_string(&skill_file) {
            Ok(c) => c,
            Err(e) => {
                warn!("Failed to read skill file {}: {}", skill_file.display(), e);
                continue;
            }
        };

        if let Some(mut source) =
            parse_skill_content(&content, &registered_skill_dir, global, writable)
        {
            if !seen.contains(&source.name) {
                let mut files = Vec::new();
                let mut visited_support_dirs = HashSet::new();
                walk_files_recursively(
                    skill_dir,
                    &mut visited_support_dirs,
                    &mut |path| !should_skip_dir(path) && !path.join("SKILL.md").is_file(),
                    &mut |path| {
                        if path.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
                            if let Ok(relative) = path.strip_prefix(skill_dir) {
                                files.push(
                                    registered_skill_dir
                                        .join(relative)
                                        .to_string_lossy()
                                        .into_owned(),
                                );
                            }
                        }
                    },
                );
                source.supporting_files = files;

                seen.insert(source.name.clone());
                sources.push(source);
            }
        }
    }
    sources
}

fn parse_frontmatter<T: for<'de> Deserialize<'de>>(
    content: &str,
) -> Result<Option<(T, String)>, serde_norway::Error> {
    let parts: Vec<&str> = content.split("---").collect();
    if parts.len() < 3 {
        return Ok(None);
    }

    let yaml_content = parts[1].trim();
    let metadata: T = serde_norway::from_str(yaml_content)?;

    let body = parts[2..].join("---").trim().to_string();
    Ok(Some((metadata, body)))
}

pub fn split_command_args(input: &str) -> anyhow::Result<Vec<String>> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_double_quote = false;
    let mut in_single_quote = false;

    for c in input.chars() {
        match c {
            '"' if !in_single_quote => in_double_quote = !in_double_quote,
            '\'' if !in_double_quote && (in_single_quote || current.is_empty()) => {
                in_single_quote = !in_single_quote
            }
            c if c.is_whitespace() && !in_double_quote && !in_single_quote => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(c),
        }
    }

    if in_double_quote || in_single_quote {
        return Err(anyhow::anyhow!("Unmatched quote in command"));
    }

    if !current.is_empty() {
        parts.push(current);
    }

    Ok(parts)
}

/// Per-turn snapshot: roots are supplied by Buzz, never model arguments.
pub struct Skills {
    entries: Vec<SourceEntry>,
}
impl Skills {
    pub fn discover(roots: &[PathBuf]) -> Self {
        let mut seen = HashSet::new();
        let entries = roots
            .iter()
            .flat_map(|root| scan_skills_from_dir(root, false, false, false, &mut seen))
            .collect();
        Self { entries }
    }
    pub fn instructions(&self) -> String {
        let mut entries: Vec<_> = self.entries.iter().collect();
        entries.sort_by(|a, b| (&a.name, &a.path).cmp(&(&b.name, &b.path)));
        let mut text = String::from("Available filesystem skills (load with load_skill):");
        for entry in entries {
            text.push_str(&format!("\n• {} - {}", entry.name, entry.description));
        }
        text
    }
    pub fn load(&self, name: &str, args: Option<&str>) -> Result<String> {
        if let Some(entry) = self.entries.iter().find(|s| s.name == name) {
            return loaded_skill_context_with_args(entry, args);
        }
        #[cfg(unix)]
        if let Some((parent, relative)) = name.split_once('/') {
            let relative = relative.replace('\\', "/");
            if let Some(entry) = self.entries.iter().find(|s| s.name == parent) {
                let dir = Path::new(&entry.path);
                for file in &entry.supporting_files {
                    if let Ok(rel) = Path::new(file).strip_prefix(dir) {
                        if rel.to_string_lossy().replace('\\', "/") == relative {
                            return Ok(supporting_files::load_supporting_file(dir, rel, name)?);
                        }
                    }
                }
            }
        }
        anyhow::bail!("Skill or supporting file not found: {name}")
    }
}
#[cfg(test)]
mod tests;
