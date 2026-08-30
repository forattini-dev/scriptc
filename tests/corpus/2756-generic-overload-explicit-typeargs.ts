function select<T>(kind: "value", value: T): T;
function select<T>(kind: "pair", value: T): [T, T];
function select<T>(kind: "value" | "pair", value: T): T | [T, T] {
  return kind === "value" ? value : [value, value];
}

const answer = select<number>("value", 41);
console.log(answer + 1);
