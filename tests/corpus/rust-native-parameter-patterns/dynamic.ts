function choose({drop, value = "default", ...rest}: any): string {
  console.log("value", value === null, value === false, value === 0, value === "default");
  return Object.keys(rest).join("|");
}
console.log("dynamic", choose({drop: 1, value: null, extra: 2}), choose({value: false, other: 3}), choose({value: 0}), choose({}));
function left({a, ...rest}: any): string { return Object.keys(rest).join("|"); }
function right({b, ...rest}: any): string { return Object.keys(rest).join("|"); }
console.log("exclusions", left({a: 1, b: 2}), right({a: 1, b: 2}));
function repeat({a: x, a: y, ...rest}: any): string { return String(x) + String(y) + Object.keys(rest).join("|"); }
console.log("repeat", repeat({a: 1, b: 2}));
