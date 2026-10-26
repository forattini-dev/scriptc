// @rust-only
// @no-engine
let prior: unknown = undefined;
console.log("replacement", "a b".replace(/(?<first>a)|(?<second>b)/g, (match, first, second, offset, input, groups) => {
  console.log("groups", "first" in groups, "second" in groups, "constructor" in groups, "toString" in groups, "__proto__" in groups);
  console.log("symbol", Symbol.iterator in groups, groups === prior);
  prior = groups;
  const view: { first?: string; second?: string } = groups;
  console.log("view", "constructor" in view, "first" in view, view === groups);
  const copy = { ...view };
  console.log("spread", "constructor" in copy, "first" in copy, copy === view);
  groups.extra = undefined;
  console.log("mutation", "extra" in groups, Object.hasOwn(groups, "extra"));
  delete groups.first;
  console.log("delete", "first" in groups, "first" in view, "first" in copy);
  return String(first) + ":" + String(second);
}));
