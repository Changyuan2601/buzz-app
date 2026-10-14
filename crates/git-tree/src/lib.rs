//! Git's NUL/tab tree protocol and package admission. Cargo executes the same
//! bodies Verus checks; subprocesses, UTF-8 presentation and signatures stay with callers.
use vstd::prelude::*;
#[cfg(verus_keep_ghost)]
use vstd::string::StringSliceAdditionalSpecFns;
mod bytes;
mod index;
mod package;
use bytes::compare;
#[cfg(verus_keep_ghost)]
use bytes::{lex, lex_pair, lex_trans};
use core::cmp::Ordering;
pub use package::{Selection, ARTIFACT, MANIFEST, MODULE, SIGNATURE};

verus! {

#[derive(Debug, Clone, Copy, PartialEq, Eq, Structural)]
pub enum Kind { Regular, Symlink, Tree, Gitlink }

#[derive(Debug)]
pub struct Entry {
    pub kind: Kind,
    pub oid: Vec<u8>,
    pub path: Vec<u8>,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Structural)]
pub enum Error { Framing, Metadata, ObjectId, Size, Path, Duplicate, Count }

pub open spec fn hex(b: u8) -> bool {
    (b'0' <= b <= b'9') || (b'a' <= b <= b'f') || (b'A' <= b <= b'F')
}
pub open spec fn object_id(s: Seq<u8>) -> bool {
    (s.len() == 40 || s.len() == 64) && forall|i: int| 0 <= i < s.len() ==> hex(#[trigger] s[i])
}
pub open spec fn decimal(s: Seq<u8>, value: nat) -> bool {
    s.len() > 0 && (forall|i: int| 0 <= i < s.len() ==> b'0' <= #[trigger] s[i] <= b'9')
    && value == digits(s)
}
pub open spec fn digits(s: Seq<u8>) -> nat
    decreases s.len(),
{
    if s.len() == 0 { 0 } else { digits(s.drop_last()) * 10 + (s.last() - b'0') as nat }
}
pub open spec fn path_ok(s: Seq<u8>) -> bool {
    s.len() > 0 && forall|i: int| 0 <= i < s.len() ==> s[i] != 0
}

/// First separator, or the slice length. This does not skip empty records.
fn find(data: &[u8], start: usize, byte: u8) -> (end: usize)
    requires start <= data.len(),
    ensures start <= end <= data.len(),
        end < data.len() ==> data@[end as int] == byte,
        forall|i: int| start <= i < end ==> data@[i] != byte,
{
    let mut end = start;
    while end < data.len()
        invariant start <= end <= data.len(),
            forall|i: int| start <= i < end ==> data@[i] != byte,
        decreases data.len() - end,
    {
        if data[end] == byte { return end; }
        end += 1;
    }
    end
}

fn copy(data: &[u8], start: usize, end: usize) -> (out: Vec<u8>)
    requires start <= end <= data.len(),
    ensures out@ == data@.subrange(start as int, end as int),
{
    let mut out = Vec::new();
    let mut i = start;
    while i < end
        invariant start <= i <= end <= data.len(),
            out@ == data@.subrange(start as int, i as int),
        decreases end - i,
    {
        out.push(data[i]);
        i += 1;
    }
    out
}

fn equal(a: &[u8], b: &[u8]) -> (yes: bool)
    ensures yes == (a@ == b@),
{
    if a.len() != b.len() { return false; }
    let mut i = 0;
    while i < a.len()
        invariant i <= a.len(), a.len() == b.len(),
            forall|j: int| 0 <= j < i ==> a@[j] == b@[j],
        decreases a.len() - i,
    {
        if a[i] != b[i] { return false; }
        i += 1;
    }
    proof { assert(a@ =~= b@); }
    true
}

// ASCII helpers lack specifications in this pin; wrapping subtraction has an exact model.
fn valid_oid(data: &[u8]) -> (yes: bool)
    ensures yes == object_id(data@),
{
    if data.len() != 40 && data.len() != 64 { return false; }
    let mut i = 0;
    while i < data.len()
        invariant i <= data.len(), data.len() == 40 || data.len() == 64,
            forall|j: int| 0 <= j < i ==> hex(#[trigger] data@[j]),
        decreases data.len() - i,
    {
        let b = data[i];
        if !(b.wrapping_sub(b'0') < 10 || b.wrapping_sub(b'a') < 6 || b.wrapping_sub(b'A') < 6) {
            return false;
        }
        i += 1;
    }
    true
}

fn size(data: &[u8]) -> (out: Result<u64, Error>)
    ensures out is Ok ==> decimal(data@, out->Ok_0 as nat),
{
    if data.is_empty() { return Err(Error::Size); }
    let mut value = 0u64;
    let mut i = 0;
    while i < data.len()
        invariant i <= data.len(), value as nat == digits(data@.subrange(0, i as int)),
            forall|j: int| 0 <= j < i ==> b'0' <= #[trigger] data@[j] <= b'9',
        decreases data.len() - i,
    {
        let b = data[i];
        if b.wrapping_sub(b'0') >= 10 { return Err(Error::Size); }
        let digit = (b - b'0') as u64;
        if value > (u64::MAX - digit) / 10 { return Err(Error::Size); }
        proof {
            assert(data@.subrange(0, i as int + 1).drop_last() == data@.subrange(0, i as int));
        }
        value = value * 10 + digit;
        i += 1;
    }
    proof { assert(data@.subrange(0, data.len() as int) =~= data@); }
    Ok(value)
}

pub open spec fn well_formed(e: Entry) -> bool {
    object_id(e.oid@) && path_ok(e.path@)
    && ((e.kind == Kind::Regular || e.kind == Kind::Symlink) == e.size.is_some())
}

/// Metadata is exactly mode SP type SP oid SP padded-size TAB raw-path.
pub open spec fn record_parts(raw: Seq<u8>, e: Entry, a: int, b: int, c: int, d: int, t: int) -> bool {
        0 < a < b < c <= d < t < raw.len()
        && raw[a] == b' ' && raw[b] == b' ' && raw[c] == b' ' && raw[t] == b'\t'
        && (forall|i: int| c < i < d ==> raw[i] == b' ')
        && e.oid@ == raw.subrange(b + 1, c)
        && e.path@ == raw.subrange(t + 1, raw.len() as int)
        && match e.kind {
            Kind::Regular => (raw.subrange(0, a) == seq![b'1',b'0',b'0',b'6',b'4',b'4']
                || raw.subrange(0, a) == seq![b'1',b'0',b'0',b'7',b'5',b'5'])
                && raw.subrange(a + 1, b) == seq![b'b',b'l',b'o',b'b'],
            Kind::Symlink => raw.subrange(0, a) == seq![b'1',b'2',b'0',b'0',b'0',b'0']
                && raw.subrange(a + 1, b) == seq![b'b',b'l',b'o',b'b'],
            Kind::Tree => raw.subrange(0, a) == seq![b'0',b'4',b'0',b'0',b'0',b'0']
                && raw.subrange(a + 1, b) == seq![b't',b'r',b'e',b'e'],
            Kind::Gitlink => raw.subrange(0, a) == seq![b'1',b'6',b'0',b'0',b'0',b'0']
                && raw.subrange(a + 1, b) == seq![b'c',b'o',b'm',b'm',b'i',b't'],
        }
        && match e.size {
            Some(n) => decimal(raw.subrange(d, t), n as nat),
            None => raw.subrange(d, t) == seq![b'-'],
        }
}

pub open spec fn record(raw: Seq<u8>, e: Entry) -> bool {
    exists|a: int, b: int, c: int, d: int, t: int| #[trigger] record_parts(raw,e,a,b,c,d,t)
}

fn parse_record(data: &[u8]) -> (out: Result<Entry, Error>)
    requires forall|i: int| 0 <= i < data.len() ==> data@[i] != 0,
    ensures out is Ok ==> well_formed(out->Ok_0) && record(data@, out->Ok_0),
{
    proof {
        reveal_strlit("100644"); vstd::string::is_ascii_spec_bytes("100644");
        assert("100644".spec_bytes() == seq![b'1',b'0',b'0',b'6',b'4',b'4']);
        reveal_strlit("100755"); vstd::string::is_ascii_spec_bytes("100755");
        assert("100755".spec_bytes() == seq![b'1',b'0',b'0',b'7',b'5',b'5']);
        reveal_strlit("blob"); vstd::string::is_ascii_spec_bytes("blob");
        assert("blob".spec_bytes() == seq![b'b',b'l',b'o',b'b']);
        reveal_strlit("120000"); vstd::string::is_ascii_spec_bytes("120000");
        assert("120000".spec_bytes() == seq![b'1',b'2',b'0',b'0',b'0',b'0']);
        reveal_strlit("040000"); vstd::string::is_ascii_spec_bytes("040000");
        assert("040000".spec_bytes() == seq![b'0',b'4',b'0',b'0',b'0',b'0']);
        reveal_strlit("tree"); vstd::string::is_ascii_spec_bytes("tree");
        assert("tree".spec_bytes() == seq![b't',b'r',b'e',b'e']);
        reveal_strlit("160000"); vstd::string::is_ascii_spec_bytes("160000");
        assert("160000".spec_bytes() == seq![b'1',b'6',b'0',b'0',b'0',b'0']);
        reveal_strlit("commit"); vstd::string::is_ascii_spec_bytes("commit");
        assert("commit".spec_bytes() == seq![b'c',b'o',b'm',b'm',b'i',b't']);
        reveal_strlit("-"); vstd::string::is_ascii_spec_bytes("-");
        assert("-".spec_bytes() == seq![b'-']);
    }
    let a = find(data, 0, b' ');
    if a == data.len() { return Err(Error::Metadata); }
    let b = find(data, a + 1, b' ');
    if b == data.len() { return Err(Error::Metadata); }
    let c = find(data, b + 1, b' ');
    if c == data.len() { return Err(Error::Metadata); }
    let t = find(data, c + 1, b'\t');
    if t == data.len() || t + 1 == data.len() { return Err(Error::Path); }
    let mode = copy(data, 0, a);
    let kind_text = copy(data, a + 1, b);
    let kind = if equal(&mode, "100644".as_bytes()) || equal(&mode, "100755".as_bytes()) {
        if !equal(&kind_text, "blob".as_bytes()) { return Err(Error::Metadata); }
        Kind::Regular
    } else if equal(&mode, "120000".as_bytes()) {
        if !equal(&kind_text, "blob".as_bytes()) { return Err(Error::Metadata); }
        Kind::Symlink
    } else if equal(&mode, "040000".as_bytes()) {
        if !equal(&kind_text, "tree".as_bytes()) { return Err(Error::Metadata); }
        Kind::Tree
    } else if equal(&mode, "160000".as_bytes()) {
        if !equal(&kind_text, "commit".as_bytes()) { return Err(Error::Metadata); }
        Kind::Gitlink
    } else { return Err(Error::Metadata); };
    proof { assert(a == 6); assert(a < b < c); }
    let oid = copy(data, b + 1, c);
    if !valid_oid(&oid) { return Err(Error::ObjectId); }
    let mut d = c + 1;
    while d < t && data[d] == b' '
        invariant c < d <= t, t < data.len(), a == 6, a < b < c,
            forall|i: int| c < i < d ==> data@[i] == b' ',
        decreases t - d,
    { d += 1; }
    let number = copy(data, d, t);
    let size = if kind == Kind::Regular || kind == Kind::Symlink {
        Some(size(&number)?)
    } else {
        if !equal(&number, "-".as_bytes()) { return Err(Error::Size); }
        None
    };
    let path = copy(data, t + 1, data.len());
    let entry = Entry { kind, oid, path, size };
    proof {
        assert(0 < a < b < c <= d < t < data.len());
        assert(entry.oid@ == data@.subrange(b as int + 1, c as int));
        assert(entry.path@ == data@.subrange(t as int + 1, data.len() as int));
        assert(match entry.size {
            Some(n) => decimal(data@.subrange(d as int, t as int), n as nat),
            None => data@.subrange(d as int, t as int) == seq![b'-'],
        });
        assert(record_parts(data@, entry, a as int, b as int, c as int, d as int, t as int));
    }
    Ok(entry)
}


/// Every input record occurs exactly once, with its original framing and bytes.
pub open spec fn framed(raw: Seq<u8>, entries: Seq<Entry>, spans: Seq<(int,int)>, end: int) -> bool {
    spans.len() == entries.len() && 0 <= end <= raw.len()
    && (spans.len() == 0 ==> end == 0)
    && (spans.len() > 0 ==> spans[0].0 == 0 && spans.last().1 + 1 == end)
    && forall|i:int| #![trigger spans[i]] 0 <= i < spans.len() ==> {
        let start = spans[i].0; let stop = spans[i].1;
        0 <= start < stop < end && raw[stop] == 0
        && (i > 0 ==> start == spans[i-1].1 + 1)
        && (forall|j:int| start <= j < stop ==> raw[j] != 0)
        && well_formed(entries[i]) && record(raw.subrange(start,stop),entries[i])
    }
}
proof fn append_frame(raw: Seq<u8>, entries: Seq<Entry>, spans: Seq<(int,int)>, start:int, end:int, entry:Entry)
    requires framed(raw,entries,spans,start), start < end < raw.len(), raw[end] == 0,
        forall|j:int| start <= j < end ==> raw[j] != 0,
        well_formed(entry), record(raw.subrange(start,end),entry),
    ensures framed(raw,entries.push(entry),spans.push((start,end)),end+1),
{
    let next_entries = entries.push(entry); let next_spans = spans.push((start,end));
    assert(next_spans.last() == (start,end));
    if spans.len() == 0 { assert(start == 0); } else { assert(spans.last().1 + 1 == start); }
    assert forall|i:int| #![trigger next_spans[i]] 0 <= i < next_spans.len() implies {
        let a=next_spans[i].0; let b=next_spans[i].1;
        0 <= a < b < end+1 && raw[b] == 0
        && (i > 0 ==> a == next_spans[i-1].1 + 1)
        && (forall|j:int| a <= j < b ==> raw[j] != 0)
        && well_formed(next_entries[i]) && record(raw.subrange(a,b),next_entries[i])
    } by {
        if i < entries.len() { assert(spans[i].1 < start); }
    }
}
pub open spec fn strict(entries: Seq<Entry>, order: Seq<usize>) -> bool {
    index::valid(entries,order)
    && forall|i:int,j:int| 0 <= i < j < order.len() ==>
        lex(entries[order[i] as int].path@,entries[order[j] as int].path@,0) == Ordering::Less
}

pub struct Tree {
    entries: Vec<Entry>,
    order: Vec<usize>,
    #[allow(dead_code)] // Erased provenance witness; ordinary Rust never reads it.
    source: Ghost<Seq<u8>>,
    #[allow(dead_code)] // Erased record-framing witness.
    spans: Ghost<Seq<(int,int)>>,
}
impl Tree {
    pub closed spec fn view(&self) -> Seq<Entry> { self.entries@ }
    pub closed spec fn bytes(&self) -> Seq<u8> { self.source@ }
    pub closed spec fn valid(&self) -> bool {
        framed(self.source@,self.entries@,self.spans@,self.source@.len() as int)
        && strict(self.entries@,self.order@)
        && self.order@.to_multiset() == index::range(0,self.entries.len() as int).to_multiset()
    }
    pub fn entries(&self) -> (entries: &[Entry])
        ensures entries@ == self.view(),
    { self.entries.as_slice() }

    /// Exact raw-path lookup, including nonregular marker entries.
    pub fn find(&self, path: &[u8]) -> (out: Option<usize>)
        requires self.valid(),
        ensures match out {
            Some(i) => i < self.view().len() && self.view()[i as int].path@ == path@,
            None => forall|i:int| 0 <= i < self.view().len() ==> self.view()[i].path@ != path@,
        },
    {
        let mut lo = 0usize; let mut hi = self.order.len();
        while lo < hi
            invariant lo <= hi <= self.order.len(), self.valid(),
                forall|i:int| 0 <= i < lo ==> lex(self.entries@[self.order@[i] as int].path@,path@,0) == Ordering::Less,
                forall|i:int| hi <= i < self.order.len() ==> lex(self.entries@[self.order@[i] as int].path@,path@,0) == Ordering::Greater,
            decreases hi-lo,
        {
            let mid = lo + (hi-lo)/2;
            let index = self.order[mid];
            let key = &self.entries[index].path;
            match compare(key,path) {
                Ordering::Equal => {
                    proof { lex_pair(key@,path@,0); assert(key@ =~= path@); }
                    return Some(index);
                },
                Ordering::Less => {
                    proof {
                        assert forall|i:int| lo <= i < mid implies lex(self.entries@[self.order@[i] as int].path@,path@,0) == Ordering::Less by {
                            lex_trans(self.entries@[self.order@[i] as int].path@,key@,path@,0);
                        }
                    }
                    lo = mid+1;
                },
                Ordering::Greater => {
                    proof {
                        lex_pair(path@,key@,0);
                        assert forall|i:int| mid < i < hi implies lex(self.entries@[self.order@[i] as int].path@,path@,0) == Ordering::Greater by {
                            lex_trans(path@,key@,self.entries@[self.order@[i] as int].path@,0);
                            lex_pair(path@,self.entries@[self.order@[i] as int].path@,0);
                        }
                    }
                    hi = mid;
                },
            }
        }
        proof {
            broadcast use {vstd::seq_lib::group_to_multiset_ensures,vstd::multiset::group_multiset_axioms};
            assert forall|i:int| 0 <= i < self.entries.len() implies self.entries@[i].path@ != path@ by {
                let all = index::range(0,self.entries.len() as int);
                assert(all[i] == i as usize);
                assert(all.contains(i as usize));
                vstd::seq_lib::to_multiset_contains(all,i as usize);
                vstd::seq_lib::to_multiset_contains(self.order@,i as usize);
                assert(self.order@.contains(i as usize));
                let j = choose|j:int| 0 <= j < self.order.len() && self.order@[j] == i as usize;
                lex_pair(self.entries@[i].path@,path@,0);
            }
        }
        None
    }
}

/// Parse the complete Git `ls-tree -r [-t] -l -z --full-tree` output.
/// Empty repositories succeed; empty/truncated records and duplicate paths fail.
pub fn parse(data: &[u8], max_entries: usize) -> (out: Result<Tree,Error>)
    ensures out is Ok ==> out->Ok_0.valid() && out->Ok_0.bytes() == data@
        && out->Ok_0.view().len() <= max_entries,
{
    let mut entries = Vec::new();
    let mut cursor = 0usize;
    let ghost mut spans = Seq::<(int,int)>::empty();
    while cursor < data.len()
        invariant cursor <= data.len(), entries.len() <= max_entries,
            framed(data@,entries@,spans,cursor as int),
        decreases data.len()-cursor,
    {
        if entries.len() == max_entries { return Err(Error::Count); }
        let end = find(data,cursor,0);
        if end == data.len() || end == cursor { return Err(Error::Framing); }
        let raw = copy(data,cursor,end);
        let entry = parse_record(&raw)?;
        proof {
            append_frame(data@,entries@,spans,cursor as int,end as int,entry);
            spans = spans.push((cursor as int,end as int));
        }
        entries.push(entry);
        cursor = end+1;
    }
    let order = index::sort(&entries,0,entries.len());
    let mut i = 1usize;
    while i < order.len()
        invariant i >= 1, i <= order.len() || order.len() == 0,
            index::valid(entries@,order@), index::sorted(entries@,order@),
            forall|j:int,k:int| 0 <= j < k < i && k < order.len() ==>
                lex(entries@[order@[j] as int].path@,entries@[order@[k] as int].path@,0) == Ordering::Less,
        decreases order.len()-i,
    {
        let previous = &entries[order[i-1]].path;
        let next = &entries[order[i]].path;
        if matches!(compare(previous,next),Ordering::Equal) { return Err(Error::Duplicate); }
        proof {
            assert(bytes::le(previous@,next@));
            assert(lex(previous@,next@,0) == Ordering::Less);
            assert forall|j:int| 0 <= j < i implies lex(entries@[order@[j] as int].path@,next@,0) == Ordering::Less by {
                if j < i-1 { lex_trans(entries@[order@[j] as int].path@,previous@,next@,0); }
            }
        }
        i += 1;
    }
    Ok(Tree {entries,order,source:Ghost(data@),spans:Ghost(spans)})
}

} // verus!

#[cfg(test)]
mod tests;
