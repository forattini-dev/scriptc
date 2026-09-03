// process.version — Node's "v" + process.versions.node. The binary
// answers with its Node COMPATIBILITY TARGET (SEMANTICS.md divergence 60,
// the versions.node stance): there is no Node underneath to report a
// patch level for, so the raw string differs from a live Node's by
// design. The corpus pins the DERIVED facts programs actually use — the
// "v" prefix, the dotted shape, the major-version gate, and the
// version/versions.node invariant — exactly as 1531 does for arch.
const v = process.version;
console.log(typeof v);
console.log(v.startsWith("v"));
console.log(v === `v${process.versions.node}`);
console.log(v.slice(1).split(".").length);

const major = parseInt(v.slice(1).split(".")[0]!, 10);
console.log(major >= 24);
console.log(Number.isNaN(major));

// The engine-gate idiom a CLI prints on startup.
console.log(v.replace(/^v/, "").split(".").length === 3 ? "parsed" : "unparsed");
const banner = `node ${v}`;
console.log(banner.length > 5);
