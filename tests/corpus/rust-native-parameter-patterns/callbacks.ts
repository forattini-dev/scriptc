type Input = { value: number; label?: string };
const callback = ({value, label = "D", ...rest}: Input): string => String(value) + label + Object.keys(rest).join("|");
const alias = callback;
console.log("callback", alias({value: 2}), alias({value: 3, label: "L"}));
class Reader {
  read({value, label = "M"}: Input): string { return String(value) + label; }
}
console.log("method", new Reader().read({value: 4}));
class Printer {
  constructor({value, label = "K"}: Input) { console.log("constructor", value, label); }
}
new Printer({value: 5});
