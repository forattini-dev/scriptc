type Spec = { kind: "a"; value: string } | { kind: "b"; value: string } | { kind: "c"; count: number };
type Out = ({ kind: "c"; count: number } | { kind: "b"; value: string } | { kind: "a"; value: string }) & { flag?: true };
function wrap(pr: Spec): Out { return { ...pr, flag: true }; }
function show(p: Out): void { console.log("case", p.kind, p.flag === true, Object.keys(p).join("|")); }
show(wrap({ kind: "b", value: "bee" })); show(wrap({ kind: "a", value: "aye" })); show(wrap({ kind: "c", count: 3 }));
