const identity = <T>(value: T): T => value;

console.log(identity<number>(7));
console.log(identity<string>("stable"));
