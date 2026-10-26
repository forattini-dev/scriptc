let previous: any = undefined;
console.log("named", "a b".replace(/(?<first>a)|(?<second>b)/g, (match, first, second, offset, input, groups) => {
  console.log("groups", Object.keys(groups).join("|"), groups.first === undefined, groups.second === undefined,
    Object.hasOwn(groups, "first"), Object.hasOwn(groups, "second"), groups === previous);
  previous = groups;
  groups.first = "mutated";
  return String(first) + ":" + String(second);
}));
console.log("absent", "a".replace(/a/, (match, offset, input, groups) => {
  console.log("arguments", offset === 0, input === "a", groups === undefined); return "X";
}));
