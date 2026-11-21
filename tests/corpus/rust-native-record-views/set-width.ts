type Scan = {
  names: ReadonlySet<string>;
  label: string;
};

type Full = Scan & {
  extra: boolean;
};

function narrow(value: Scan): Scan {
  const alias: any = value;
  alias.label = "changed";
  alias.added = "visible";
  return value;
}

const names = new Set(["one"]);
const full: Full = { names, label: "before", extra: true };
const view = narrow(full);
const raw: any = full;
const erased: any = view;
console.log(
  "set width",
  raw === erased,
  full.label,
  view.names === names,
  view.names.has("one"),
  String(erased.added),
  Object.keys(view).join("|"),
);
