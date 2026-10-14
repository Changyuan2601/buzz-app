//! Standalone: compile with pinned bin/rustc; no Djinn in app builds.
use std::{hint::black_box, time::Instant};
#[path = "../../../src-tauri/src/host_process/text.rs"]
mod decoder;
#[path = "../../../src-tauri/src/host_process/utf8_tail.rs"]
mod kernel;
mod historical {
    include!("historical.rs");
}

// Correct full-scan reference: skip each malformed sequence and keep scanning
// until finding an incomplete sequence. No assumption about the first error.
fn full_scan(bytes: &[u8]) -> usize {
    let mut offset = 0;
    loop {
        match std::str::from_utf8(&bytes[offset..]) {
            Ok(_) => return 0,
            Err(e) => match e.error_len() {
                Some(n) => offset += e.valid_up_to() + n,
                None => return bytes.len() - offset - e.valid_up_to(),
            },
        }
    }
}

fn reference(pending: &mut Vec<u8>) -> String {
    let complete = pending.len() - full_scan(pending);
    let rest = pending.split_off(complete);
    let text = String::from_utf8_lossy(pending).into_owned();
    *pending = rest;
    text
}

fn decode(chunks: &[Vec<u8>], which: usize, collect: bool) -> String {
    let mut output = String::new();
    let mut pending = Vec::new();
    let mut decoder = decoder::TextDecoder::default();
    for bytes in chunks {
        let text = if which == 2 {
            decoder.push(black_box(bytes))
        } else {
            pending.extend_from_slice(black_box(bytes));
            if which == 0 {
                historical::take_text(&mut pending)
            } else {
                reference(&mut pending)
            }
        };
        if collect {
            output.push_str(&text);
        }
        black_box(text);
    }
    let final_text = if which == 2 {
        decoder.finish()
    } else if which == 1 {
        String::from_utf8_lossy(&pending).into_owned()
    } else {
        String::new()
    }; // Historical forward dropped pending at EOF.
    if collect {
        output.push_str(&final_text);
    }
    black_box(final_text);
    output
}

fn check_arbitrary_streams() {
    let mut state = 0x7a83_c594_03ab_426du64;
    for case in 0..100_000 {
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let len = next() as usize % 513;
        let bytes: Vec<u8> = (0..len).map(|_| next() as u8).collect();
        let mut chunks = Vec::new();
        let mut pos = 0;
        while pos < len {
            let end = (pos + 1 + next() as usize % 65).min(len);
            chunks.push(bytes[pos..end].to_vec());
            pos = end;
        }
        assert_eq!(
            decode(&chunks, 2, true),
            String::from_utf8_lossy(&bytes),
            "case {case}"
        );
        assert_eq!(decode(&chunks, 1, true), String::from_utf8_lossy(&bytes));
        assert_eq!(kernel::tail_len(&bytes), full_scan(&bytes));
    }
    eprintln!("100000 deterministic arbitrary streams checked against whole-stream std oracle");
}

fn check_all_short_partitions() {
    const BYTES: [u8; 25] = [
        0, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xe1, 0xe2,
        0xec, 0xed, 0xef, 0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xfe, 0xff,
    ];
    let mut strings = 0;
    let mut partitions = 0;
    for len in 0..=4 {
        for mut code in 0..BYTES.len().pow(len) {
            let mut bytes = vec![0; len as usize];
            for b in &mut bytes {
                *b = BYTES[code % BYTES.len()];
                code /= BYTES.len();
            }
            strings += 1;
            assert_eq!(kernel::tail_len(&bytes), full_scan(&bytes));
            let expected = String::from_utf8_lossy(&bytes);
            for cuts in 0..(1usize << bytes.len().saturating_sub(1)) {
                let mut decoder = decoder::TextDecoder::default();
                let mut output = String::new();
                let mut start = 0;
                for end in 1..bytes.len() {
                    if cuts & (1 << (end - 1)) != 0 {
                        output.push_str(&decoder.push(&bytes[start..end]));
                        start = end;
                    }
                }
                output.push_str(&decoder.push(&bytes[start..]));
                output.push_str(&decoder.finish());
                assert_eq!(output, expected, "bytes={bytes:x?}, cuts={cuts:b}");
                partitions += 1;
            }
        }
    }
    eprintln!("{strings} representative strings, {partitions} partitions checked using production decoder");
}

fn main() {
    check_arbitrary_streams();
    check_all_short_partitions();
    if std::env::args().any(|a| a == "--check-only") {
        return;
    }
    let workloads: Vec<(&str, Vec<Vec<u8>>)> = [
        ("ascii_64k", vec![b'x'; 1_048_576], 65_536),
        ("multibyte_64k", "a€𐀀x".repeat(116_508).into_bytes(), 65_536),
        ("ascii_64", vec![b'x'; 1_048_576], 64),
        ("multibyte_1024", "a€𐀀x".repeat(116_508).into_bytes(), 1024),
        ("malformed_64k", [b'a', 0xff, b'b'].repeat(349_525), 65_536),
        (
            "malformed_split_tail",
            [0xff, 0xe2, 0x82, 0xac, b'x', 0xe2, 0x82].repeat(65_536),
            2,
        ),
    ]
    .into_iter()
    .map(|(name, data, size)| (name, data.chunks(size).map(|b| b.to_vec()).collect()))
    .collect();
    println!("mode,workload,implementation,trial,iterations,bytes,elapsed_ns");
    for (name, chunks) in &workloads {
        let bytes: usize = chunks.iter().map(Vec::len).sum();
        let all: Vec<u8> = chunks.iter().flatten().copied().collect();
        let expected = String::from_utf8_lossy(&all);
        let old_ok = decode(chunks, 0, true) == expected;
        eprintln!(
            "{name}: bytes={bytes}, chunks={}, historical_equivalent={old_ok}",
            chunks.len()
        );
        for which in 0..3 {
            if which == 0 && !old_ok {
                continue;
            }
            assert_eq!(decode(chunks, which, true), expected);
        }
        for mode in ["kernel", "decoder"] {
            if mode == "kernel" && *name == "malformed_split_tail" {
                continue;
            }
            for trial in 0..9 {
                // Rotate order to limit systematic warm-cache/order effects.
                for which in (0..3).map(|i| (i + trial) % 3) {
                    if which == 0 && (!old_ok || mode == "kernel") {
                        continue;
                    }
                    let run = || {
                        if mode == "decoder" {
                            black_box(decode(chunks, which, false));
                        } else {
                            for chunk in chunks {
                                let n = if which == 1 {
                                    full_scan(black_box(chunk))
                                } else {
                                    kernel::tail_len(black_box(chunk))
                                };
                                black_box(n);
                            }
                        }
                    };
                    run(); // warmup
                    let calibration = Instant::now();
                    for _ in 0..4 {
                        run();
                    }
                    let elapsed = calibration.elapsed().as_nanos().max(1);
                    let iterations = (80_000_000u128 * 4 / elapsed).clamp(1, 100_000) as usize;
                    let start = Instant::now();
                    for _ in 0..iterations {
                        run();
                    }
                    let ns = start.elapsed().as_nanos();
                    let implementation = ["historical", "full_scan", "bounded"][which];
                    println!("{mode},{name},{implementation},{trial},{iterations},{bytes},{ns}");
                }
            }
        }
    }
}
