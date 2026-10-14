import Utf8Tail.Code.Funs
import Utf8Tail.Prefixes

open Aeneas Std Result Utf8Tail.Spec Djinn.Vocab
set_option maxHeartbeats 2000000
namespace Utf8Tail.Proofs
 theorem tail_len.impl_correct (bytes : Aeneas.Std.Slice U8) (_h : tail_len_pre bytes.val) :
    Utf8Tail.spec.tail_len bytes ⦃ r => tail_len_spec bytes.val r ⦄ := by
  unfold Utf8Tail.spec.tail_len Utf8Tail.solution.tail_len Utf8Tail.solution.kernel.tail_len
  step* -grind +scalarTac
  all_goals simp (disch := omega) [tail_spec_iff, p1, p2, p3, cont,
    getElem!_pos, Slice.len_val, Slice.length] at *
  all_goals try simp_all [Slice.len_val, Slice.length]
  all_goals try simp (disch := omega) only [getElem!_pos, getElem?_pos, Option.getD_some] at *
  all_goals first
    | omega
    | (have hzero : bytes.len = 0#usize := by assumption
       have hz : bytes.len.val = 0 := by rw [hzero]; rfl
       have hlen : bytes.val.length = 0 := by
         simpa only [Slice.len_val, Slice.length] using hz
       omega)


/-! ## scalar_encoding -/

theorem scalar_encoding.wf :
    ∀  (full : List U8),
      scalar_encoding_spec  full →
      (∀ i : ℤ, 1 ≤ i → i < (full.length : ℤ) → (0 ≤ i ∧ i < (full.length : ℤ))) ∧
      (∀ i : ℤ, 1 ≤ i → i < (full.length : ℤ) → 128 ≤ ((full[i.toNat]!).val : ℤ) → (0 ≤ i ∧ i < (full.length : ℤ))) ∧
      ((full.length : ℤ) = 2 → (0 < (full.length : ℤ))) ∧
      (((full.length : ℤ) = 2 ∧ 194 ≤ ((full[0]!).val : ℤ)) → (0 < (full.length : ℤ))) ∧
      ((full.length : ℤ) = 3 → (0 < (full.length : ℤ))) ∧
      (((full.length : ℤ) = 3 ∧ 224 ≤ ((full[0]!).val : ℤ)) → (0 < (full.length : ℤ))) ∧
      ((((full.length : ℤ) = 3 ∧ 224 ≤ ((full[0]!).val : ℤ)) ∧ ((full[0]!).val : ℤ) ≤ 239) → (0 < (full.length : ℤ))) ∧
      ((((full.length : ℤ) = 3 ∧ 224 ≤ ((full[0]!).val : ℤ)) ∧ ((full[0]!).val : ℤ) ≤ 239) → ¬(((full[0]!).val : ℤ) ≠ 224) → (1 < (full.length : ℤ))) ∧
      (((((full.length : ℤ) = 3 ∧ 224 ≤ ((full[0]!).val : ℤ)) ∧ ((full[0]!).val : ℤ) ≤ 239) ∧ (((full[0]!).val : ℤ) ≠ 224 ∨ ((full[1]!).val : ℤ) ≥ 160)) → (0 < (full.length : ℤ))) ∧
      (((((full.length : ℤ) = 3 ∧ 224 ≤ ((full[0]!).val : ℤ)) ∧ ((full[0]!).val : ℤ) ≤ 239) ∧ (((full[0]!).val : ℤ) ≠ 224 ∨ ((full[1]!).val : ℤ) ≥ 160)) → ¬(((full[0]!).val : ℤ) ≠ 237) → (1 < (full.length : ℤ))) ∧
      ((full.length : ℤ) = 4 → (0 < (full.length : ℤ))) ∧
      (((full.length : ℤ) = 4 ∧ 240 ≤ ((full[0]!).val : ℤ)) → (0 < (full.length : ℤ))) ∧
      ((((full.length : ℤ) = 4 ∧ 240 ≤ ((full[0]!).val : ℤ)) ∧ ((full[0]!).val : ℤ) ≤ 244) → (0 < (full.length : ℤ))) ∧
      ((((full.length : ℤ) = 4 ∧ 240 ≤ ((full[0]!).val : ℤ)) ∧ ((full[0]!).val : ℤ) ≤ 244) → ¬(((full[0]!).val : ℤ) ≠ 240) → (1 < (full.length : ℤ))) ∧
      (((((full.length : ℤ) = 4 ∧ 240 ≤ ((full[0]!).val : ℤ)) ∧ ((full[0]!).val : ℤ) ≤ 244) ∧ (((full[0]!).val : ℤ) ≠ 240 ∨ ((full[1]!).val : ℤ) ≥ 144)) → (0 < (full.length : ℤ))) ∧
      (((((full.length : ℤ) = 4 ∧ 240 ≤ ((full[0]!).val : ℤ)) ∧ ((full[0]!).val : ℤ) ≤ 244) ∧ (((full[0]!).val : ℤ) ≠ 240 ∨ ((full[1]!).val : ℤ) ≥ 144)) → ¬(((full[0]!).val : ℤ) ≠ 244) → (1 < (full.length : ℤ))) := by
  intros; simp_all [scalar_encoding_spec, proper_suffix_spec]; omega

/-! ## proper_suffix -/

theorem proper_suffix.wf :
    ∀ (bytes : List U8) (k : ℤ),
      proper_suffix_spec bytes k →
      ∀ full : List U8, (scalar_encoding_spec  full ∧ k < (full.length : ℤ) ∧ (∀ i : ℤ, 0 ≤ i → i < k → bytes[(((bytes.length : ℤ) - k) + i).toNat]! = full[i.toNat]!)) → ∀ i : ℤ, 0 ≤ i → i < k → (0 ≤ (((bytes.length : ℤ) - k) + i) ∧ (((bytes.length : ℤ) - k) + i) < (bytes.length : ℤ)) ∧ (0 ≤ i ∧ i < (full.length : ℤ)) := by
  intro bytes k h full hf i hi hk
  obtain ⟨_, ⟨_, _⟩, _, _⟩ := h
  obtain ⟨_, _, _⟩ := hf
  omega

/-! ## tail_len -/

theorem tail_len.unambiguous :
    ∀ (bytes : List U8) (o₁ : Usize) (o₂ : Usize),
      tail_len_spec bytes o₁ → tail_len_spec bytes o₂ → o₁ = o₂ := by
  intro bytes a b ha hb
  apply UScalar.eq_of_val_eq
  by_cases hza : a.val = 0
  · by_cases hzb : b.val = 0
    · omega
    obtain ⟨k, hk, he⟩ := hb.2.2.2.1 (by scalar_tac)
    have hh := ha.2.2.2.2 k hk.2.1.1 (by have := hk.2.1.2; omega) hk
    omega
  obtain ⟨k, hk, he⟩ := ha.2.2.2.1 (by scalar_tac)
  have hab := hb.2.2.2.2 k hk.2.1.1 (by have := hk.2.1.2; omega) hk
  by_cases hzb : b.val = 0
  · omega
  obtain ⟨j, hj, hjb⟩ := hb.2.2.2.1 (by scalar_tac)
  have hba := ha.2.2.2.2 j hj.2.1.1 (by have := hj.2.1.2; omega) hj
  omega

/-! ## obligations added by a later `translate` (specification changed) -/



end Utf8Tail.Proofs
