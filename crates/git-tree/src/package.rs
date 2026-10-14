use crate::{copy, Kind, Tree};
use vstd::prelude::*;

verus! {
// Explicit arrays expose exact bytes; this Verus pin treats b"..." as opaque.
// Scope the style exception to these four constants, rather than add literal adapters.
#[allow(clippy::byte_char_slices)]
pub const MANIFEST: [u8;13] = [b'm',b'a',b'n',b'i',b'f',b'e',b's',b't',b'.',b'j',b's',b'o',b'n'];
#[allow(clippy::byte_char_slices)]
pub const MODULE: [u8;9] = [b'p',b'l',b'u',b'g',b'i',b'n',b'.',b'j',b's'];
#[allow(clippy::byte_char_slices)]
pub const ARTIFACT: [u8;20] = [b'p',b'l',b'u',b'g',b'i',b'n',b'.',b'a',b'r',b't',b'i',b'f',b'a',b'c',b't',b'.',b'j',b's',b'o',b'n'];
#[allow(clippy::byte_char_slices)]
pub const SIGNATURE: [u8;21] = [b'p',b'l',b'u',b'g',b'i',b'n',b'.',b's',b'i',b'g',b'n',b'a',b't',b'u',b'r',b'e',b'.',b'j',b's',b'o',b'n'];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Structural)]
pub enum Selection {
    Signed { artifact: usize, signature: usize },
    Unsigned { manifest: usize, module: usize },
    InvalidSigned, MissingModule, TooLarge, NoPackage, InvalidParent,
}

fn join(parent: &[u8], name: &[u8]) -> (path: Vec<u8>)
    requires parent.len()+name.len() <= usize::MAX,
    ensures path@ == parent@ + name@,
{
    let mut path = copy(parent,0,parent.len());
    let mut i = 0usize;
    while i < name.len()
        invariant i <= name.len(), parent.len()+name.len() <= usize::MAX,
            path@ == parent@ + name@.subrange(0,i as int),
        decreases name.len()-i,
    {
        path.push(name[i]); i += 1;
    }
    proof { assert(name@.subrange(0,name.len() as int) =~= name@); }
    path
}

pub open spec fn directory(parent: Seq<u8>) -> bool {
    parent.len() == 0 || parent.last() == b'/'
}
pub open spec fn no_marker(tree: Tree, parent: Seq<u8>) -> bool {
    forall|i:int| 0 <= i < tree.view().len() ==>
        #[trigger] tree.view()[i].path@ != parent + ARTIFACT@
        && tree.view()[i].path@ != parent + SIGNATURE@
}
pub open spec fn selected(tree: Tree, parent: Seq<u8>, name: Seq<u8>, i: usize, limit: u64) -> bool {
    i < tree.view().len() && tree.view()[i as int].path@ == parent+name
    && tree.view()[i as int].kind == Kind::Regular
    && tree.view()[i as int].size is Some && tree.view()[i as int].size->Some_0 <= limit
}
impl Tree {
    /// Marker lookup always precedes blob eligibility. No entry is prefiltered.
    pub fn package(&self, parent: &[u8], limit: u64) -> (out: Selection)
        requires self.valid(),
        ensures match out {
            Selection::Signed{artifact,signature} => directory(parent@)
                && selected(*self,parent@,ARTIFACT@,artifact,limit)
                && selected(*self,parent@,SIGNATURE@,signature,limit),
            Selection::Unsigned{manifest,module} => directory(parent@) && no_marker(*self,parent@)
                && selected(*self,parent@,MANIFEST@,manifest,limit)
                && selected(*self,parent@,MODULE@,module,limit),
            _ => true,
        },
    {
        if parent.len() > usize::MAX - SIGNATURE.len()
            || (!parent.is_empty() && parent[parent.len()-1] != b'/') {
            return Selection::InvalidParent;
        }
        let artifact_path = join(parent,&ARTIFACT);
        let signature_path = join(parent,&SIGNATURE);
        let artifact = self.find(&artifact_path);
        let signature = self.find(&signature_path);
        let ghost release_marked = artifact.is_some() || signature.is_some();
        // Presence includes trees, symlinks and gitlinks, even though none can supply bytes.
        if artifact.is_some() || signature.is_some() {
            let (Some(a),Some(s)) = (artifact,signature) else { return Selection::InvalidSigned; };
            let first = &self.entries[a]; let second = &self.entries[s];
            if first.kind != Kind::Regular || second.kind != Kind::Regular {
                return Selection::InvalidSigned;
            }
            let (Some(first_size),Some(second_size)) = (first.size,second.size) else {
                return Selection::InvalidSigned;
            };
            if first_size > limit || second_size > limit { return Selection::TooLarge; }
            return Selection::Signed{artifact:a,signature:s};
        }
        proof { assert(!release_marked); }
        let manifest_path = join(parent,&MANIFEST);
        let module_path = join(parent,&MODULE);
        let Some(manifest) = self.find(&manifest_path) else { return Selection::NoPackage; };
        if self.entries[manifest].kind != Kind::Regular { return Selection::NoPackage; }
        let Some(module) = self.find(&module_path) else { return Selection::MissingModule; };
        let first = &self.entries[manifest]; let second = &self.entries[module];
        if second.kind != Kind::Regular { return Selection::MissingModule; }
        let (Some(first_size),Some(second_size)) = (first.size,second.size) else { return Selection::MissingModule; };
        if first_size > limit || second_size > limit { return Selection::TooLarge; }
        Selection::Unsigned{manifest,module}
    }
}
} // verus!
