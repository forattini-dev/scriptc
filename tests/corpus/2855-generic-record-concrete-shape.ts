interface ValueSpec<T> {
  type?: "array";
  coerce: (raw: string) => T;
}

function readSpec<Spec extends ValueSpec<unknown>>(spec: Spec): void {
  console.log(spec.type ?? "value");
  console.log(spec.coerce("3"));
}

readSpec({ coerce: (raw: string) => Number(raw) });

interface BooleanSpec {
  kind: "boolean";
}

interface CoercedSpec<T> {
  kind: "value";
  coerce: (raw: string) => T;
}

function readFlag<Spec extends BooleanSpec | CoercedSpec<unknown>>(spec: Spec): void {
  if (spec.kind === "boolean") console.log("boolean");
  else console.log(spec.coerce("4"));
}

readFlag({ kind: "boolean" });
