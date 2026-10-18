type Spec = { kind: "a"; text: string; note?: string; flag?: boolean } | { kind: "b"; count: number; note?: string; flag?: boolean };
type Out = Spec & { extra: string };
function wrap(pr: Spec): Out { return { ...pr, flag: true, extra: "end" }; }
function show(pr: Spec): void { const out = wrap(pr); console.log("case", Object.keys(out).join("|"), Object.hasOwn(out, "note"), out.note === undefined, out.flag === true, out.extra); }
show({ text: "x", kind: "a" });
show({ note: undefined, count: 1, kind: "b", flag: false });
show({ flag: false, kind: "a", note: "n", text: "x" });
