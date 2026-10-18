type Spec = { kind: "apt"; pkg: string } | { kind: "ppa"; ppa: string; pkgs: string[] } | { kind: "skip"; reason: string };
type Provider = Spec & { needsSudo?: true; needsAdmin?: true };
const sudoProvider = (pr: Spec): Provider => ({ ...pr, needsSudo: true });
const admin = (pr: Spec): Provider => ({ ...pr, needsAdmin: true });
function show(pr: Provider): void {
 console.log("case", pr.kind, pr.needsSudo === true, pr.needsAdmin === true, Object.keys(pr).join("|"));
 if (pr.kind === "apt") console.log("case", pr.pkg);
 if (pr.kind === "ppa") console.log("case", pr.ppa, pr.pkgs.join(","));
 if (pr.kind === "skip") console.log("case", pr.reason);
}

show(sudoProvider({ kind: "apt", pkg: "git" }));
show(admin({ kind: "ppa", ppa: "example", pkgs: ["a", "b"] }));
show(sudoProvider({ kind: "skip", reason: "done" }));

// The previous single-record-arm path still permits widening copied fields.
function optionalCopy(pr: { value: string }): { value?: string } | undefined { return { ...pr }; }
const copied = optionalCopy({ value: "kept" });
if (copied !== undefined) console.log("case", copied.value === "kept", Object.keys(copied).join("|"));
