/- Bridge from existential scalar completion to the finite tail predicates.
   Authored proof; generated Spec and Code modules remain unchanged. -/
import Aeneas
import Utf8Tail.Spec
import Utf8Tail.Code.Funs
import Utf8Tail.Vocab

open Aeneas Std Result
open Utf8Tail.Spec
open Djinn.Vocab

set_option maxHeartbeats 10000000

namespace Utf8Tail.Proofs

-- Finite frag predicates used only in the proof, derived from the grammar.
abbrev cont (b : U8) : Prop := 128 ≤ b.val ∧ b.val ≤ 191
abbrev p1 (a : U8) : Prop := 194 ≤ a.val ∧ a.val ≤ 244
abbrev p2 (a b : U8) : Prop :=
  (224 ≤ a.val ∧ a.val ≤ 239 ∧ cont b ∧
    (a.val ≠ 224 ∨ 160 ≤ b.val) ∧ (a.val ≠ 237 ∨ b.val ≤ 159)) ∨
  (240 ≤ a.val ∧ a.val ≤ 244 ∧ cont b ∧
    (a.val ≠ 240 ∨ 144 ≤ b.val) ∧ (a.val ≠ 244 ∨ b.val ≤ 143))
abbrev p3 (a b c : U8) : Prop :=
  240 ≤ a.val ∧ a.val ≤ 244 ∧ cont b ∧ cont c ∧
    (a.val ≠ 240 ∨ 144 ≤ b.val) ∧ (a.val ≠ 244 ∨ b.val ≤ 143)

-- A scalar's first k bytes are a proper frag.
def completion (frag : List U8) : Prop :=
  ∃ full : List U8, scalar_encoding_spec full ∧
    frag.length < full.length ∧
    ∀ i : ℕ, i < frag.length → frag[i]! = full[i]!

lemma complete1 (a : U8) : completion [a] ↔ p1 a := by
  constructor
  · rintro ⟨f, ⟨_, hl, hc, hg⟩, hk, he⟩
    have h0 := he 0 (by simp)
    simp only [List.getElem!_cons_zero] at h0
    rw [← h0] at hg
    rcases hg with h | h | h <;> simp_all [p1] <;> omega
  · intro h
    by_cases h2 : a.val ≤ 223
    · refine ⟨[a, 128#u8], ?_, by simp, ?_⟩
      · simp only [scalar_encoding_spec, scalar_encoding_pre, List.length_cons,
          List.length_nil, List.getElem!_cons_zero, List.getElem!_cons_succ]
        refine ⟨trivial, by omega, ?_, Or.inl ?_⟩
        · intro i hi hb; have : i = 1 := by omega
          subst i; simp
        · simp_all [p1] <;> omega
      · intro i hi; have : i = 0 := by simpa using hi
        subst i; simp
    by_cases h3 : a.val ≤ 239
    · let b : U8 := if a.val = 224 then 160#u8 else 128#u8
      refine ⟨[a,b,128#u8], ?_, by simp, ?_⟩
      · simp only [scalar_encoding_spec, scalar_encoding_pre, List.length_cons,
          List.length_nil, List.getElem!_cons_zero, List.getElem!_cons_succ]
        refine ⟨trivial, by omega, ?_, Or.inr (Or.inl ?_)⟩
        · intro i hi hb
          have : i = 1 ∨ i = 2 := by omega
          rcases this with rfl | rfl <;> simp [b] <;> split <;> simp
        · simp only [b]; split <;> simp_all [p1] <;> omega
      · intro i hi; have : i = 0 := by simpa using hi
        subst i; simp
    · let b : U8 := if a.val = 240 then 144#u8 else 128#u8
      refine ⟨[a,b,128#u8,128#u8], ?_, by simp, ?_⟩
      · simp only [scalar_encoding_spec, scalar_encoding_pre, List.length_cons,
          List.length_nil, List.getElem!_cons_zero, List.getElem!_cons_succ]
        refine ⟨trivial, by omega, ?_, Or.inr (Or.inr ?_)⟩
        · intro i hi hb
          have : i = 1 ∨ i = 2 ∨ i = 3 := by omega
          rcases this with rfl | rfl | rfl <;> simp [b] <;> split <;> simp
        · simp only [b]; split <;> simp_all [p1] <;> omega
      · intro i hi; have : i = 0 := by simpa using hi
        subst i; simp

lemma complete2 (a b : U8) : completion [a,b] ↔ p2 a b := by
  constructor
  · rintro ⟨f, ⟨_, hl, hc, hg⟩, hk, he⟩
    have h0 := he 0 (by simp)
    have h1 := he 1 (by simp)
    simp only [List.getElem!_cons_zero, List.getElem!_cons_succ] at h0 h1
    have hb := hc 1 (by omega) (by simp_all <;> omega)
    rw [← h0, ← h1] at hg
    simp only [Int.toNat_one] at hb
    rw [← h1] at hb
    rcases hg with h | h | h
    · simp_all <;> omega
    · exact Or.inl (by simp_all [cont]; omega)
    · exact Or.inr (by simp_all [cont]; omega)
  · rintro (h | h)
    · refine ⟨[a,b,128#u8], ?_, by simp, ?_⟩
      · simp only [scalar_encoding_spec, scalar_encoding_pre, List.length_cons,
          List.length_nil, List.getElem!_cons_zero, List.getElem!_cons_succ]
        refine ⟨trivial, by omega, ?_, Or.inr (Or.inl ?_)⟩
        · intro i hi hb; have : i = 1 ∨ i = 2 := by omega
          rcases this with rfl | rfl <;> simpa [cont] using h.2.2.1
        · simp_all [cont]; omega
      · intro i hi; have : i = 0 ∨ i = 1 := by simp_all <;> omega
        rcases this with rfl | rfl <;> simp
    · refine ⟨[a,b,128#u8,128#u8], ?_, by simp, ?_⟩
      · simp only [scalar_encoding_spec, scalar_encoding_pre, List.length_cons,
          List.length_nil, List.getElem!_cons_zero, List.getElem!_cons_succ]
        refine ⟨trivial, by omega, ?_, Or.inr (Or.inr ?_)⟩
        · intro i hi hb; have : i = 1 ∨ i = 2 ∨ i = 3 := by omega
          rcases this with rfl | rfl | rfl <;> simp_all [cont]
        · simp_all [cont]; omega
      · intro i hi; have : i = 0 ∨ i = 1 := by simp_all <;> omega
        rcases this with rfl | rfl <;> simp

lemma complete3 (a b c : U8) : completion [a,b,c] ↔ p3 a b c := by
  constructor
  · rintro ⟨f, ⟨_, hl, hc, hg⟩, hk, he⟩
    have h0 := he 0 (by simp)
    have h1 := he 1 (by simp)
    have h2 := he 2 (by simp)
    simp only [List.getElem!_cons_zero, List.getElem!_cons_succ] at h0 h1 h2
    have hb := hc 1 (by omega) (by simp_all <;> omega)
    have hc' := hc 2 (by omega) (by simp_all <;> omega)
    simp only [Int.toNat_one, Int.reduceToNat] at hb hc'
    rw [← h0, ← h1] at hg
    rw [← h1] at hb
    rw [← h2] at hc'
    rcases hg with h | h | h <;> simp_all [p3, cont] <;> omega
  · intro h
    refine ⟨[a,b,c,128#u8], ?_, by simp, ?_⟩
    · simp only [scalar_encoding_spec, scalar_encoding_pre, List.length_cons,
        List.length_nil, List.getElem!_cons_zero, List.getElem!_cons_succ]
      refine ⟨trivial, by omega, ?_, Or.inr (Or.inr ?_)⟩
      · intro i hi hb; have : i = 1 ∨ i = 2 ∨ i = 3 := by omega
        rcases this with rfl | rfl | rfl <;> simp_all [p3, cont]
      · simp_all [p3, cont]; omega
    · intro i hi; have : i = 0 ∨ i = 1 ∨ i = 2 := by simp_all <;> omega
      rcases this with rfl | rfl | rfl <;> simp



lemma suffix_completion (bytes frag : List U8)
    (hlo : 1 ≤ frag.length) (hhi : frag.length ≤ 3)
    (hb : frag.length ≤ bytes.length)
    (he : ∀ i : ℕ, i < frag.length →
      frag[i]! = bytes[(((bytes.length : ℤ) - frag.length) + i).toNat]!) :
    proper_suffix_spec bytes (frag.length : ℤ) ↔ completion frag := by
  constructor
  · rintro ⟨_, hk, hb', full, hf, hl, hm⟩
    refine ⟨full, hf, by omega, ?_⟩
    intro i hi
    rw [he i hi]
    simpa using hm (i : ℤ) (by omega) (by omega)
  · rintro ⟨full, hf, hl, hm⟩
    refine ⟨trivial, by omega, by omega, full, hf, by omega, ?_⟩
    intro i hi hik
    have hj : i.toNat < frag.length := by omega
    have hh := he i.toNat hj
    rw [show (i.toNat : ℤ) = i by omega] at hh
    exact hh.symm.trans (hm _ hj)

lemma suffix1 (bytes : List U8) : proper_suffix_spec bytes 1 ↔
    1 ≤ bytes.length ∧ p1 bytes[bytes.length-1]! := by
  by_cases hb : 1 ≤ bytes.length
  · have he : ∀ i : ℕ, i < [bytes[bytes.length-1]!].length →
        [bytes[bytes.length-1]!][i]! = bytes[(((bytes.length : ℤ)-1)+i).toNat]! := by
      intro i hi; have : i = 0 := by simp_all <;> omega
      subst i; simp only [List.getElem!_cons_zero]
      congr 1; omega
    have hh := suffix_completion bytes [bytes[bytes.length-1]!] (by simp) (by simp) hb he
    simpa [hb, complete1] using hh
  · simp only [proper_suffix_spec]
    constructor
    · intro h; have := h.2.2.1; omega
    · intro h; omega

lemma suffix2 (bytes : List U8) : proper_suffix_spec bytes 2 ↔
    2 ≤ bytes.length ∧ p2 bytes[bytes.length-2]! bytes[bytes.length-1]! := by
  by_cases hb : 2 ≤ bytes.length
  · have he : ∀ i : ℕ, i < [bytes[bytes.length-2]!,bytes[bytes.length-1]!].length →
        [bytes[bytes.length-2]!,bytes[bytes.length-1]!][i]! =
          bytes[(((bytes.length : ℤ)-2)+i).toNat]! := by
      intro i hi; have : i = 0 ∨ i = 1 := by simp_all <;> omega
      rcases this with rfl | rfl <;>
        simp only [List.getElem!_cons_zero, List.getElem!_cons_succ] <;> congr 1 <;> omega
    have hh := suffix_completion bytes [bytes[bytes.length-2]!,bytes[bytes.length-1]!]
      (by simp) (by simp) hb he
    simpa [hb, complete2] using hh
  · simp only [proper_suffix_spec]
    constructor
    · intro h; have := h.2.2.1; omega
    · intro h; omega

lemma suffix3 (bytes : List U8) : proper_suffix_spec bytes 3 ↔
    3 ≤ bytes.length ∧ p3 bytes[bytes.length-3]! bytes[bytes.length-2]! bytes[bytes.length-1]! := by
  by_cases hb : 3 ≤ bytes.length
  · have he : ∀ i : ℕ, i < [bytes[bytes.length-3]!,bytes[bytes.length-2]!,bytes[bytes.length-1]!].length →
        [bytes[bytes.length-3]!,bytes[bytes.length-2]!,bytes[bytes.length-1]!][i]! =
          bytes[(((bytes.length : ℤ)-3)+i).toNat]! := by
      intro i hi; have : i = 0 ∨ i = 1 ∨ i = 2 := by simp_all <;> omega
      rcases this with rfl | rfl | rfl <;>
        simp only [List.getElem!_cons_zero, List.getElem!_cons_succ] <;> congr 1 <;> omega
    have hh := suffix_completion bytes [bytes[bytes.length-3]!,bytes[bytes.length-2]!,bytes[bytes.length-1]!]
      (by simp) (by simp) hb he
    simpa [hb, complete3] using hh
  · simp only [proper_suffix_spec]
    constructor
    · intro h; have := h.2.2.1; omega
    · intro h; omega

lemma tail_spec_iff (bytes : List U8) (r : Usize) : tail_len_spec bytes r ↔
    (r.val : ℤ) ≤ 3 ∧ (r.val : ℤ) ≤ (bytes.length : ℤ) ∧
    ((r.val : ℤ) = 1 → 1 ≤ bytes.length ∧ p1 bytes[bytes.length-1]!) ∧
    ((r.val : ℤ) = 2 → 2 ≤ bytes.length ∧ p2 bytes[bytes.length-2]! bytes[bytes.length-1]!) ∧
    ((r.val : ℤ) = 3 → 3 ≤ bytes.length ∧ p3 bytes[bytes.length-3]! bytes[bytes.length-2]! bytes[bytes.length-1]!) ∧
    (1 ≤ bytes.length ∧ p1 bytes[bytes.length-1]! → 1 ≤ (r.val : ℤ)) ∧
    (2 ≤ bytes.length ∧ p2 bytes[bytes.length-2]! bytes[bytes.length-1]! → 2 ≤ (r.val : ℤ)) ∧
    (3 ≤ bytes.length ∧ p3 bytes[bytes.length-3]! bytes[bytes.length-2]! bytes[bytes.length-1]! → 3 ≤ (r.val : ℤ)) := by
  constructor
  · rintro ⟨_, hr, hb, hp, hm⟩
    refine ⟨hr, hb, ?_, ?_, ?_, ?_, ?_, ?_⟩
    · intro h; obtain ⟨k,hk,he⟩ := hp (by omega)
      have : k = 1 := by omega
      rw [this] at hk; exact (suffix1 bytes).mp hk
    · intro h; obtain ⟨k,hk,he⟩ := hp (by omega)
      have : k = 2 := by omega
      rw [this] at hk; exact (suffix2 bytes).mp hk
    · intro h; obtain ⟨k,hk,he⟩ := hp (by omega)
      have : k = 3 := by omega
      rw [this] at hk; exact (suffix3 bytes).mp hk
    · intro h; exact hm 1 (by omega) (by omega) ((suffix1 bytes).mpr h)
    · intro h; exact hm 2 (by omega) (by omega) ((suffix2 bytes).mpr h)
    · intro h; exact hm 3 (by omega) (by omega) ((suffix3 bytes).mpr h)
  · rintro ⟨hr,hb,h1,h2,h3,m1,m2,m3⟩
    refine ⟨trivial, hr, hb, ?_, ?_⟩
    · intro hp
      have he : (r.val : ℤ) = 1 ∨ (r.val : ℤ) = 2 ∨ (r.val : ℤ) = 3 := by omega
      rcases he with he | he | he
      · exact ⟨1, (suffix1 bytes).mpr (h1 he), by omega⟩
      · exact ⟨2, (suffix2 bytes).mpr (h2 he), by omega⟩
      · exact ⟨3, (suffix3 bytes).mpr (h3 he), by omega⟩
    · intro k hk hl hs
      have he : k = 1 ∨ k = 2 ∨ k = 3 := by omega
      rcases he with rfl | rfl | rfl
      · exact m1 ((suffix1 bytes).mp hs)
      · exact m2 ((suffix2 bytes).mp hs)
      · exact m3 ((suffix3 bytes).mp hs)



@[step] theorem continuation_spec (b : U8) :
    Utf8Tail.solution.kernel.continuation b ⦃ r => r = true ↔ (cont b) ⦄ := by
  unfold Utf8Tail.solution.kernel.continuation
  step* -grind +scalarTac <;> simp_all [cont, UScalar.le_equiv] <;> omega

@[step] theorem single_spec (b : U8) :
    Utf8Tail.solution.kernel.single b ⦃ r => r = true ↔ (p1 b) ⦄ := by
  unfold Utf8Tail.solution.kernel.single
  step* -grind +scalarTac <;> simp_all [p1, UScalar.le_equiv] <;> omega

@[step] theorem valid_second_spec (a b : U8) :
    Utf8Tail.solution.kernel.valid_second a b ⦃ r =>
      r = true ↔ (cont b ∧ (a.val ≠ 224 ∨ 160 ≤ b.val) ∧
        (a.val ≠ 237 ∨ b.val ≤ 159) ∧
        (a.val ≠ 240 ∨ 144 ≤ b.val) ∧ (a.val ≠ 244 ∨ b.val ≤ 143)) ⦄ := by
  unfold Utf8Tail.solution.kernel.valid_second
  step* -grind +scalarTac <;> simp_all [cont, UScalar.le_equiv, UScalar.lt_equiv,
    UScalar.eq_equiv] <;> omega



@[step] theorem pair_spec (a b : U8) :
    Utf8Tail.solution.kernel.pair a b ⦃ r => r = true ↔ (p2 a b) ⦄ := by
  unfold Utf8Tail.solution.kernel.pair
  repeat' split
  all_goals simp only [bind_ok, bind_tc_ok, Bool.true_eq_false, Bool.false_eq_true, ↓reduceIte]
  all_goals step* -grind +scalarTac <;> simp_all [p2, cont, UScalar.le_equiv] <;> omega

@[step] theorem triple_spec (a b : U8) :
    Utf8Tail.solution.kernel.triple a b ⦃ r =>
      r = true ↔ (240 ≤ a.val ∧ a.val ≤ 244 ∧ cont b ∧
        (a.val ≠ 240 ∨ 144 ≤ b.val) ∧ (a.val ≠ 244 ∨ b.val ≤ 143)) ⦄ := by
  unfold Utf8Tail.solution.kernel.triple
  repeat' split
  all_goals simp only [bind_ok, bind_tc_ok, Bool.true_eq_false, Bool.false_eq_true, ↓reduceIte]
  all_goals step* -grind +scalarTac <;> simp_all [cont, UScalar.le_equiv] <;> omega

end Utf8Tail.Proofs
