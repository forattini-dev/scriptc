use super::*;
pub(super) fn apis() -> Vec<Api> {
    [
        ("file", "BunFile is lazy and owns metadata/read methods; do not rewrite it to an eager fs.readFileSync call"),
        ("write", "Source/destination overloads, Promise completion and returned byte count need a dedicated contract"),
        ("CryptoHasher", "Algorithm sets, byte inputs, clone/update/digest lifecycle and encoding need a dedicated class adapter"),
        ("spawn", "Subprocess handles, pipes and asynchronous lifecycle need a dedicated contract"),
    ].into_iter().map(|(name, contract)| Api {
        module: "Bun", member: name, stage: Stage::Planned,
        access: if name == "CryptoHasher" { Access::Construct } else { Access::Call },
        lowering: Lowering::Unported, operations: vec![], runtime_candidates: &[],
        special: None, contract, evidence: &[],
    }).collect()
}
