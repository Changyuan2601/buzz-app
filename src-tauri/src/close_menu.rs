//! Cmd+W is a menu action that only ever closes a tab, never the window: with
//! no tab to close it does nothing. Cmd+Shift+W clears the current channel's tabs.
//! The red button still closes the window.
//! Ctrl+Tab bypasses macOS menu highlighting latency. Menu commands and the
//! native key handler both work while a raw guest webview owns keyboard focus.
use std::{cell::RefCell, ptr::NonNull};

use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, WINDOW_SUBMENU_ID},
    AppHandle, Manager, Runtime,
};

const CLOSE: &str = "buzz-close";
const CLOSE_ALL: &str = "buzz-close-all";
const NEXT: &str = "buzz-next-tab";
const PREVIOUS: &str = "buzz-previous-tab";
const REQUEST: &str = include_str!("close-request.js");
const SWITCH: &str = include_str!("switch-tab-request.js");

pub(crate) fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let close = MenuItem::with_id(app, CLOSE, "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let close_all = MenuItem::with_id(
        app,
        CLOSE_ALL,
        "Close All Tabs",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;
    // Tauri's default has Close Window in both File and Window. Preserve all
    // other native items (especially editing/services), replacing both routes.
    // Predefined items expose their label, but not their native action type.
    // A detached item reports its label with its mnemonic (`C&lose Window`),
    // one in a menu its native title (`Close Window`).
    let close_label = PredefinedMenuItem::close_window(app, None)?
        .text()?
        .replace('&', "");
    let mut replaced = 0;
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            for (index, item) in submenu.items()?.iter().enumerate() {
                if let Some(predefined) = item.as_predefined_menuitem() {
                    if predefined.text()?.replace('&', "") == close_label {
                        submenu.remove(item)?;
                        submenu.insert(&close, index)?;
                        submenu.insert(&close_all, index + 1)?;
                        replaced += 1;
                    }
                }
            }
        }
    }
    debug_assert_eq!(replaced, 2, "Tauri default Close menu structure changed");
    if let Some(window) = menu.get(WINDOW_SUBMENU_ID) {
        if let Some(window) = window.as_submenu() {
            window.append_items(&[
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, NEXT, "Show Next Tab", true, Some("Ctrl+Tab"))?,
                &MenuItem::with_id(
                    app,
                    PREVIOUS,
                    "Show Previous Tab",
                    true,
                    Some("Ctrl+Shift+Tab"),
                )?,
            ])?;
        }
    }
    install_tab_keys(app);
    Ok(menu)
}

pub(crate) fn handle<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let script = match event.id().as_ref() {
        CLOSE => format!("{{ const tabEvent = \"buzz:close-active-tab\";\n{REQUEST}}}"),
        CLOSE_ALL => format!("{{ const tabEvent = \"buzz:close-all-tabs\";\n{REQUEST}}}"),
        // A block keeps the binding out of the page's global scope.
        NEXT => format!("{{ const tabEvent = \"buzz:next-tab\";\n{SWITCH}}}"),
        PREVIOUS => format!("{{ const tabEvent = \"buzz:previous-tab\";\n{SWITCH}}}"),
        _ => return,
    };
    send_request(app, &script);
}

fn send_request<R: Runtime>(app: &AppHandle<R>, script: &str) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    // Unlike a predefined Close item, custom menu items stay enabled without
    // a key window. Never consume a retained tab in a hidden/background window.
    if !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
        || !window.is_focused().unwrap_or(false)
    {
        return false;
    }
    // Evaluate only in the trusted main view, even when a raw guest webview
    // owns keyboard focus.
    if let Err(error) = window.eval(script) {
        eprintln!("Could not send Buzz tab request: {error}");
        return false;
    }
    true
}

struct TabKeys(Retained<AnyObject>);
impl Drop for TabKeys {
    fn drop(&mut self) {
        // This token came from addLocalMonitor; creation and drop stay on the UI thread.
        unsafe { NSEvent::removeMonitor(&self.0) };
    }
}
thread_local! {
    static TAB_KEYS: RefCell<Option<TabKeys>> = const { RefCell::new(None) };
}

fn tab_key(key: u16, modifiers: NSEventModifierFlags) -> Option<&'static str> {
    if key != 48
        || !modifiers.contains(NSEventModifierFlags::Control)
        || modifiers.intersects(NSEventModifierFlags::Command | NSEventModifierFlags::Option)
    {
        return None;
    }
    Some(if modifiers.contains(NSEventModifierFlags::Shift) {
        "buzz:previous-tab"
    } else {
        "buzz:next-tab"
    })
}

// Tauri constructs the menu on the UI thread. Monitor before AppKit performs
// menu key equivalents: its highlight flash otherwise delays successive actions.
fn install_tab_keys<R: Runtime>(app: &AppHandle<R>) {
    TAB_KEYS.with(|slot| {
        if slot.borrow().is_some() {
            return;
        }
        let app = app.clone();
        let handler = RcBlock::new(move |event: NonNull<NSEvent>| {
            // AppKit supplies a live event for the duration of this callback.
            let key = unsafe { event.as_ref() };
            let Some(name) = tab_key(key.keyCode(), key.modifierFlags()) else {
                return event.as_ptr();
            };
            let script = format!("{{ const tabEvent = \"{name}\";\n{SWITCH}}}");
            if send_request(&app, &script) {
                std::ptr::null_mut()
            } else {
                event.as_ptr()
            }
        });
        // The callback returns only the original event or null to consume it.
        let token = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler)
        };
        if let Some(token) = token {
            *slot.borrow_mut() = Some(TabKeys(token));
        } else {
            eprintln!("Could not install Buzz tab keys; using menu accelerators");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_keys_preserve_direction_and_leave_other_chords_to_appkit() {
        let control = NSEventModifierFlags::Control;
        assert_eq!(tab_key(48, control), Some("buzz:next-tab"));
        assert_eq!(
            tab_key(48, control | NSEventModifierFlags::Shift),
            Some("buzz:previous-tab")
        );
        assert_eq!(
            tab_key(48, control | NSEventModifierFlags::CapsLock),
            Some("buzz:next-tab")
        );
        for modifiers in [
            NSEventModifierFlags::empty(),
            NSEventModifierFlags::Shift,
            control | NSEventModifierFlags::Command,
            control | NSEventModifierFlags::Option,
        ] {
            assert_eq!(tab_key(48, modifiers), None);
        }
        assert_eq!(tab_key(49, control), None);
    }
}
