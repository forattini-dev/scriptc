type Source = { kind: "a"; a: string; b: string };
type Target = { kind: "a"; a: string } | { kind: "b"; a: string; b: string };
const original: Source[] = [{ kind: "a", a: "first", b: "extra" }];
const erased: any = original;
const view: Target[] = erased;
const item = view[0];
if (item.kind === "a") console.log(item.a);
else console.log(item.b);
