//! Visual geometry matches the original Buzz StyledQrCode component.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use qrcode::{Color, EcLevel, QrCode};
use std::fmt::Write;

pub(super) fn render(value: &str) -> Result<String, String> {
    // Match the original component’s correction level and bounded logo area.
    let code = QrCode::with_error_correction_level(value.as_bytes(), EcLevel::M)
        .map_err(|_| "Couldn’t create the pairing code.")?;
    let size = code.width();
    let mut center = ((size * size) as f64 * 0.1).sqrt().floor() as usize;
    if center.is_multiple_of(2) {
        center -= 1;
    }
    let start = (size - center) / 2;
    let end = start + center;
    let icon_size = center as f64 * 0.8;
    let icon_start = (size as f64 - icon_size) / 2.0;
    let extent = size + 8;
    let mut svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="-4 -4 {extent} {extent}"><rect x="-4" y="-4" width="{extent}" height="{extent}" fill="white"/><g fill="black">"#
    );
    svg.push_str("<style>");
    svg.push_str(include_str!("qr-reveal.css"));
    svg.push_str("</style>");
    for row in 0..size {
        // Original 250ms reveal: row travel plus a 58ms dot animation.
        let delay = (row as f64 / size as f64 * (250.0 / 1.3)).round() as u32;
        for col in 0..size {
            let finder = (row < 7 && (col < 7 || col >= size - 7)) || (row >= size - 7 && col < 7);
            let logo = (start..end).contains(&row) && (start..end).contains(&col);
            if code[(col, row)] == Color::Dark && !finder && !logo {
                write!(svg, r#"<circle class="buzz-qr-cell-reveal" style="--buzz-qr-reveal-delay:{delay}ms" cx="{}.5" cy="{}.5" r="0.4"/>"#, col, row).unwrap();
            }
        }
    }
    svg.push_str("</g>");
    for (x, y) in [(0, 0), (size - 7, 0), (0, size - 7)] {
        write!(svg, r#"<rect x="{x}" y="{y}" width="7" height="7" rx="2" fill="black"/><rect x="{}" y="{}" width="5" height="5" rx="0.8" fill="white"/><rect x="{}" y="{}" width="3" height="3" rx="0.4" fill="black"/>"#, x + 1, y + 1, x + 2, y + 2).unwrap();
    }
    let icon = STANDARD.encode(include_bytes!("../../../public/app-icon.png"));
    write!(svg, r##"<defs><clipPath id="logo"><rect x="{icon_start}" y="{icon_start}" width="{icon_size}" height="{icon_size}" rx="2"/></clipPath></defs><rect x="{icon_start}" y="{icon_start}" width="{icon_size}" height="{icon_size}" rx="2" fill="black"/><image href="data:image/png;base64,{icon}" x="{icon_start}" y="{icon_start}" width="{icon_size}" height="{icon_size}" clip-path="url(#logo)"/></svg>"##).unwrap();
    Ok(svg)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn styled_code_keeps_quiet_zone_and_embeds_the_logo() {
        let svg = render("pairing-test").unwrap();
        assert!(svg.contains("viewBox=\"-4 -4 "));
        assert!(svg.contains("<circle"));
        assert!(svg.contains("--buzz-qr-reveal-delay:0ms"));
        assert!(svg.contains("prefers-reduced-motion: reduce"));
        assert_eq!(svg.matches("width=\"7\" height=\"7\"").count(), 3);
        assert!(svg.contains("data:image/png;base64,"));
        assert!(!svg.contains("href=\"http"));
    }
}
