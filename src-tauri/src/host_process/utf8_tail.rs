//! Length of the longest suffix that can still become one UTF-8 scalar.
//! This exact module is included by the isolated Djinn proof package.

pub(super) fn tail_len(bytes: &[u8]) -> usize {
    let n = bytes.len();
    if n == 0 {
        return 0;
    }
    let last = bytes[n - 1];
    if single(last) {
        return 1;
    }
    if !continuation(last) {
        return 0;
    }
    if n >= 2 && pair(bytes[n - 2], last) {
        return 2;
    }
    if n >= 3 && triple(bytes[n - 3], bytes[n - 2]) {
        return 3;
    }
    0
}

// Small predicates keep the Rust decisions and their proof lemmas local.
fn single(byte: u8) -> bool {
    matches!(byte, 0xc2..=0xf4)
}

fn continuation(byte: u8) -> bool {
    matches!(byte, 0x80..=0xbf)
}

fn pair(lead: u8, second: u8) -> bool {
    matches!(lead, 0xe0..=0xf4) && valid_second(lead, second)
}

fn triple(lead: u8, second: u8) -> bool {
    matches!(lead, 0xf0..=0xf4) && valid_second(lead, second)
}

fn valid_second(lead: u8, byte: u8) -> bool {
    continuation(byte)
        && (lead != 0xe0 || byte >= 0xa0)
        && (lead != 0xed || byte <= 0x9f)
        && (lead != 0xf0 || byte >= 0x90)
        && (lead != 0xf4 || byte <= 0x8f)
}
