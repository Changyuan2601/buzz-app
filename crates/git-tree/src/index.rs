#[cfg(verus_keep_ghost)]
use crate::bytes::{le, le_trans};
use crate::{bytes::compare, Entry};
use core::cmp::Ordering;
use vstd::prelude::*;

verus! {
broadcast use {vstd::seq_lib::group_to_multiset_ensures,vstd::multiset::group_multiset_axioms};
pub open spec fn valid(keys: Seq<Entry>, a: Seq<usize>) -> bool {
    forall|i:int| 0 <= i < a.len() ==> a[i] < keys.len()
}
pub open spec fn sorted(keys: Seq<Entry>, a: Seq<usize>) -> bool {
    forall|i:int,j:int| 0 <= i < j < a.len() ==> le(keys[a[i] as int].path@, keys[a[j] as int].path@)
}
fn merge(keys: &[Entry], a: &[usize], b: &[usize]) -> (r: Vec<usize>)
    requires valid(keys@,a@), valid(keys@,b@), sorted(keys@,a@), sorted(keys@,b@), a.len()+b.len() <= usize::MAX,
    ensures valid(keys@,r@), sorted(keys@,r@), r.len()==a.len()+b.len(),
        r@.to_multiset() == a@.to_multiset().add(b@.to_multiset()),
{
    let mut r=Vec::new(); let mut i=0usize; let mut j=0usize;
    while i < a.len() || j < b.len()
        invariant i<=a.len(), j<=b.len(), r.len()==i+j,
            valid(keys@,a@), valid(keys@,b@), sorted(keys@,a@), sorted(keys@,b@),
            a.len()+b.len() <= usize::MAX,
            valid(keys@,r@), sorted(keys@,r@),
            r@.to_multiset()==a@.subrange(0,i as int).to_multiset().add(b@.subrange(0,j as int).to_multiset()),
            forall|k:int,m:int| 0<=k<r.len() && i<=m<a.len() ==> le(keys[r@[k] as int].path@,keys[a@[m] as int].path@),
            forall|k:int,m:int| 0<=k<r.len() && j<=m<b.len() ==> le(keys[r@[k] as int].path@,keys[b@[m] as int].path@),
        decreases a.len()+b.len()-i-j,
    {
        let ghost previous=r@;
        let x;
        if j == b.len() || (i < a.len() && !matches!(compare(&keys[a[i]].path,&keys[b[j]].path), Ordering::Greater)) {
            x=a[i];
            proof {
                assert forall|m:int| j<=m<b.len() implies le(keys[x as int].path@,keys[b@[m] as int].path@) by {
                    crate::bytes::lex_pair(keys[b@[j as int] as int].path@,keys[b@[m] as int].path@,0);
                    le_trans(keys[x as int].path@,keys[b@[j as int] as int].path@,keys[b@[m] as int].path@);
                }
                assert(a@.subrange(0,(i+1) as int) == a@.subrange(0,i as int).push(x));
            }
            i+=1;
        } else {
            x=b[j];
            proof {
                if i < a.len() { crate::bytes::lex_pair(keys[a@[i as int] as int].path@,keys[x as int].path@,0); }
                assert forall|m:int| i<=m<a.len() implies le(keys[x as int].path@,keys[a@[m] as int].path@) by {
                    crate::bytes::lex_pair(keys[a@[i as int] as int].path@,keys[a@[m] as int].path@,0);
                    le_trans(keys[x as int].path@,keys[a@[i as int] as int].path@,keys[a@[m] as int].path@);
                }
                assert(b@.subrange(0,(j+1) as int) == b@.subrange(0,j as int).push(x));
            }
            j+=1;
        }
        r.push(x);
    }
    proof { assert(a@.subrange(0,i as int) == a@); assert(b@.subrange(0,j as int) == b@); }
    r
}
pub open spec fn range(lo:int, hi:int) -> Seq<usize> { Seq::new((hi-lo) as nat, |i:int| (lo+i) as usize) }
pub fn sort(keys: &[Entry], lo:usize, hi:usize) -> (r: Vec<usize>)
    requires lo<=hi<=keys.len(),
    ensures valid(keys@,r@), sorted(keys@,r@), r.len()==hi-lo,
        r@.to_multiset()==range(lo as int,hi as int).to_multiset(),
    decreases hi-lo,
{
    if hi-lo<=1 {
        let mut r=Vec::new();
        if lo<hi { r.push(lo); }
        proof { assert(r@ =~= range(lo as int, hi as int)); }
        r
    } else {
        let mid=lo+(hi-lo)/2;
        let a=sort(keys,lo,mid);
        let b=sort(keys,mid,hi);
        let r=merge(keys,&a,&b);
        proof {
            let left=range(lo as int,mid as int); let right=range(mid as int,hi as int);
            assert(left+right =~= range(lo as int,hi as int));
            vstd::seq_lib::lemma_multiset_commutative(left,right);
        }
        r
    }
}
} // verus!
