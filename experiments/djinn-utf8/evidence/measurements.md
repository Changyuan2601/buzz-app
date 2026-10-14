# Local Blox measurements

Command: `taskset -c 2 experiments/djinn-utf8/bench.sh /tmp/buzz-djinn-implementation-evidence/final-bench`.
Buzz base: `9c90857e3c1048a08b7fdd571eb836ec3639791d`; final production sources are identified by `bench-source-sha256.txt`.
Intel Xeon 6975P-C, KVM x86_64 Linux, 32 visible logical CPUs, cgroup CPU quota equivalent to 8 cores. Rust 1.98.1/LLVM22.1.8, `-C opt-level=3`, default target CPU. Single benchmark process pinned to CPU2, no dedicated-host or fixed-frequency claim. Inputs/comparison outside timing; streaming output allocation and dropping inside timing. Nine samples with warmup/calibration and rotating order.

Times below are microseconds per whole payload (~1MiB, except split-tail 448KiB). Cells show **median [min,max]**. Ratios use medians, not fastest samples. Raw elapsed nanoseconds and iteration counts are in `bench.csv`.

|Complete decoder workload|Historical|Correct full scan|Bounded|Historical / bounded|Full scan / bounded|
|---|---:|---:|---:|---:|---:|
|ascii_64k|332.02 [331.80,335.55]|331.98 [331.83,332.44]|287.89 [287.79,288.00]|1.15×|1.15×|
|multibyte_64k|1232.31 [1227.31,1236.04]|1236.05 [1215.86,1243.27]|569.88 [564.55,576.95]|2.16×|2.17×|
|ascii_64|1087.99 [1079.50,1094.77]|1084.37 [1070.85,1089.07]|787.56 [784.12,796.23]|1.38×|1.38×|
|multibyte_1024|1251.15 [1243.65,1269.76]|1251.07 [1245.27,1258.06]|560.55 [556.23,565.41]|2.23×|2.23×|
|malformed_64k|1676.41 [1668.16,1682.18]|3128.62 [3118.62,3141.88]|1642.09 [1632.18,1648.15]|1.02×|1.91×|
|malformed_split_tail|omitted: wrong output|10237.03 [10195.40,10286.63]|5753.28 [5710.08,5773.59]|—|1.78×|

The 64KiB multibyte workload repeats `a€𐀀x`, deliberately allowing scalars to cross reads. The final complete decoder gain is **2.16×** versus historical on that equivalent-output workload (1.232ms → 0.570ms); at 1KiB reads it is 2.23×. ASCII gains are 1.15× at 64KiB and 1.38× at 64bytes. Malformed64KiB gains only 1.02× versus historical; no large gain claimed there. Split-tail omits historical because output differs; the correct-reference gain is 1.78×. These are decoder computation/allocations, excluding Tauri serialization, event transport and process IO. Application-wide performance was not measured.

Kernel timing isolates the boundary decision. The workload payload size describes the chunks presented, not bytes actually read by the bounded algorithm. Do not interpret these timings as memory bandwidth or full decoding speedup.

|Kernel workload|Correct full scan µs/payload|Bounded µs/payload|Ratio|
|---|---:|---:|---:|
|ascii_64k|22.755 [22.749,22.771]|0.035 [0.035,0.036]|644×|
|multibyte_64k|636.118 [634.635,655.734]|0.035 [0.034,0.036]|18103×|
|ascii_64|87.408 [85.907,88.624]|27.009 [26.942,27.278]|3×|
|multibyte_1024|637.123 [635.302,641.545]|2.059 [2.044,2.071]|309×|
|malformed_64k|1463.383 [1454.533,1487.343]|0.036 [0.035,0.037]|40874×|

The large kernel ratios reflect O(n) full scanning versus at most three byte positions. Whole decoding still scans and allocates output; its gains above are much smaller. The full-scan reference intentionally retains the historical buffering/allocating approach while repairing correctness, and is a comparison point, not a claim of the fastest possible full-scan decoder. Synthetic malformed data stresses repeated error scanning and is not asserted to resemble ordinary plugin output.

Calibration targets 80ms but stops at 100,000 iterations. The fastest bounded-kernel samples reached that cap: ASCII64KiB samples lasted **3.534 [3.495,3.627] ms**, multibyte64KiB **3.514 [3.431,3.620] ms**, and malformed64KiB **3.580 [3.527,3.654] ms** (median [min,max] across nine samples). Bounded ASCII64-byte samples lasted 77.726 [76.489,79.925] ms; multibyte1KiB 74.169 [73.258,76.996] ms. Complete-decoder samples lasted 60.837–81.774 ms across all implementations/workloads. Thus the large kernel ratios rely on shorter samples with less protection from host noise; they are supporting algorithm evidence, not the performance headline. Raw durations and iteration counts are retained in `bench.csv`.

Before timing, actual production code passed 406,901 representative strings across all 3,188,776 partitions and 100,000 deterministic arbitrary streams against whole-stream std decoding. This is executable evidence, not a proof of wrapper composition.
