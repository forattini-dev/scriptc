//! Portable singleton operations; symbol identity never comes from its description.
pub(crate) fn well_known_symbol(operation: &str) -> Option<&'static str> {
    Some(match operation {
        "sym.asyncIterator" => "AsyncIterator",
        "sym.hasInstance" => "HasInstance",
        "sym.isConcatSpreadable" => "IsConcatSpreadable",
        "sym.iterator" => "Iterator",
        "sym.match" => "Match",
        "sym.matchAll" => "MatchAll",
        "sym.replace" => "Replace",
        "sym.search" => "Search",
        "sym.species" => "Species",
        "sym.split" => "Split",
        "sym.toPrimitive" => "ToPrimitive",
        "sym.toStringTag" => "ToStringTag",
        "sym.unscopables" => "Unscopables",
        "sym.dispose" => "Dispose",
        "sym.asyncDispose" => "AsyncDispose",
        _ => return None,
    })
}
