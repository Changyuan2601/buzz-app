//! Each webview's page loads. Work a page starts belongs to that load, in that
//! webview: it stops when the same webview loads a page again, and a request
//! the page made before it reloaded is refused. Another webview's load leaves
//! it alone.
use std::collections::HashMap;

/// One page load in one webview.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Page {
    webview: String,
    load: u64,
}
impl Page {
    pub(crate) fn webview(&self) -> &str {
        &self.webview
    }
}

/// Counts each webview's page loads.
#[derive(Default)]
pub(crate) struct PageLoads {
    loads: HashMap<String, u64>,
    exiting: bool,
}
impl PageLoads {
    /// The page `webview` shows now.
    pub(crate) fn current(&self, webview: &str) -> Page {
        Page {
            webview: webview.into(),
            load: self.loads.get(webview).copied().unwrap_or_default(),
        }
    }
    pub(crate) fn is_current(&self, page: &Page) -> bool {
        !self.exiting && *page == self.current(&page.webview)
    }
    /// `webview` started loading another page.
    pub(crate) fn load(&mut self, webview: &str) {
        *self.loads.entry(webview.into()).or_default() += 1;
    }
    /// The app is exiting: no page is current any more.
    pub(crate) fn exit(&mut self) {
        self.exiting = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_load_ends_only_its_own_webviews_page() {
        let mut pages = PageLoads::default();
        let main = pages.current("main");
        let agents = pages.current("agents");
        pages.load("main");
        assert!(!pages.is_current(&main));
        assert!(pages.is_current(&agents));
        assert!(pages.is_current(&pages.current("main")));
        pages.exit();
        assert!(!pages.is_current(&agents));
    }
}
