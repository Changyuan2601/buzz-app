//! Independent grammar: a proper suffix admits SOME complete scalar encoding.
use djinn::djinn;

djinn! {
    pub rel scalar_encoding() -> full: Vec<u8> {
        2 <= full.len() <= 4;
        for i in 1..full.len() { 0x80 <= full[i] <= 0xbf; }
        cases {
            full.len() == 2 && 0xc2 <= full[0] <= 0xdf;
            full.len() == 3 && 0xe0 <= full[0] <= 0xef
                && (full[0] != 0xe0 || full[1] >= 0xa0)
                && (full[0] != 0xed || full[1] <= 0x9f);
            full.len() == 4 && 0xf0 <= full[0] <= 0xf4
                && (full[0] != 0xf0 || full[1] >= 0x90)
                && (full[0] != 0xf4 || full[1] <= 0x8f);
        }
    }

    pub rel proper_suffix(bytes: &[u8]) -> k: int {
        1 <= k <= 3;
        k <= bytes.len();
        some full: Vec<u8> {
            scalar_encoding() == full;
            k < full.len();
            for i in 0..k { bytes[bytes.len() - k + i] == full[i]; }
        }
    }

    pub fn tail_len(bytes: &[u8]) -> r: usize {
        r <= 3;
        r <= bytes.len();
        r > 0 => proper_suffix(bytes) == r;
        for k in 1..4 { proper_suffix(bytes) == k => k <= r; }
    }
}
