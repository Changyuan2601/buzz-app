use core::cmp::Ordering;
use vstd::prelude::*;

verus! {
pub open spec fn lex(a: Seq<u8>, b: Seq<u8>, i: int) -> Ordering
    decreases a.len() + b.len() - 2 * i,
{
    if i >= a.len() { if i >= b.len() { Ordering::Equal } else { Ordering::Less } }
    else if i >= b.len() { Ordering::Greater }
    else if a[i] < b[i] { Ordering::Less }
    else if a[i] > b[i] { Ordering::Greater }
    else { lex(a, b, i + 1) }
}
pub proof fn lex_pair(a: Seq<u8>, b: Seq<u8>, i: int)
    requires 0 <= i <= a.len(), i <= b.len(),
    ensures
        (lex(a,b,i) == Ordering::Equal) == (a.len() == b.len() && forall|j: int| i <= j < a.len() ==> a[j] == b[j]),
        (lex(a,b,i) == Ordering::Less) == (lex(b,a,i) == Ordering::Greater),
    decreases a.len() + b.len() - 2 * i,
{
    if i < a.len() && i < b.len() && a[i] == b[i] {
        lex_pair(a,b,i+1);
    }
}

pub proof fn lex_trans(a: Seq<u8>, b: Seq<u8>, c: Seq<u8>, i: int)
    requires 0 <= i, lex(a,b,i) == Ordering::Less, lex(b,c,i) == Ordering::Less,
    ensures lex(a,c,i) == Ordering::Less,
    decreases a.len()+b.len()+c.len()-3*i,
{
    if i < a.len() && i < b.len() && i < c.len() && a[i] == b[i] && b[i] == c[i] {
        lex_trans(a,b,c,i+1);
    }
}
pub fn compare(a: &[u8], b: &[u8]) -> (r: Ordering)
        ensures r == lex(a@,b@,0),
    {
        let mut i = 0usize;
        while i < a.len() && i < b.len()
            invariant i <= a.len(), i <= b.len(),
                lex(a@,b@,0) == lex(a@,b@,i as int),
            decreases a.len() - i,
        {
            if a[i] < b[i] { return Ordering::Less; }
            if a[i] > b[i] { return Ordering::Greater; }
            i += 1;
        }
        if i == a.len() {
            if i == b.len() { Ordering::Equal } else { Ordering::Less }
        } else { Ordering::Greater }
    }
pub open spec fn le(a: Seq<u8>, b: Seq<u8>) -> bool { lex(a,b,0) != Ordering::Greater }
pub proof fn le_trans(a: Seq<u8>, b: Seq<u8>, c: Seq<u8>)
    requires le(a,b), le(b,c),
    ensures le(a,c),
{
    lex_pair(a,b,0); lex_pair(b,c,0);
    if lex(a,b,0) == Ordering::Equal { assert(a =~= b); }
    else if lex(b,c,0) == Ordering::Equal { assert(b =~= c); }
    else { lex_trans(a,b,c,0); }
}
} // verus!
