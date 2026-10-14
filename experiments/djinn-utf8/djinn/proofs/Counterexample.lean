import Utf8Tail.Proofs
open Aeneas Std Utf8Tail.Spec Utf8Tail.Proofs

-- Code review reproduced the historical decoder's zero retained bytes.
-- These theorems reject that observed result; the tool did not discover it.
theorem historical_result_rejected :
    ¬ tail_len_spec [255#u8, 226#u8] 0#usize := by
  simp [tail_spec_iff, p1, p2, p3, cont]

theorem correct_result_accepted :
    tail_len_spec [255#u8, 226#u8] 1#usize := by
  simp [tail_spec_iff, p1, p2, p3, cont]

#print axioms historical_result_rejected
#print axioms correct_result_accepted
