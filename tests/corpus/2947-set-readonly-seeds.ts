const words = ["pear", "apple", "pear"] as const;
const named = new Set<string>(words);
console.log(named.size, named.has("apple"), [...named].join(","));

const inferred = new Set(words);
console.log(inferred.size, inferred.has("pear"), [...inferred].join(","));

const readonlyWords: readonly string[] = ["north", "south", "north"];
const fromReadonlyArray = new Set(readonlyWords);
console.log(fromReadonlyArray.size, [...fromReadonlyArray].join(","));

const numbers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 3] as const;
const fromTuple = new Set<number>(numbers);
console.log(fromTuple.size, [...fromTuple].join(","));

let seedCalls = 0;
function makeSeed() {
  seedCalls++;
  return ["once", "twice", "once"] as const;
}
const fromCall = new Set<string>(makeSeed());
console.log(seedCalls, fromCall.size, [...fromCall].join(","));

const direct = new Set(["red", "blue", "red"] as const);
console.log(direct.size, [...direct].join(","));
