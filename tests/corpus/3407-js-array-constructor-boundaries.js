// @rust-only
// @no-engine

function check(length) {
  try {
    const array = new Array(length);
    console.log("valid", length, array.length, 0 in array);
  } catch (error) {
    console.log("invalid", length, error.name, error.message);
  }
}

check(-1);
check(2.5);
check(NaN);
check(Infinity);
check(4294967296);
check(-0);
check(4294967295);

const entries = new Array(2);
entries[1] = undefined;
console.log("presence", 0 in entries, 1 in entries, Object.hasOwn(entries, "0"), Object.hasOwn(entries, "1"));
entries[4] = "x";
entries.length = 1;
entries.length = 3;
console.log("truncate", entries.length, 0 in entries, 1 in entries, 4 in entries, entries[4] === undefined);
entries["01"] = "leading";
entries[-1] = "negative";
entries[1.5] = "fraction";
entries[4294967295] = "maximum";
console.log("properties", entries.length, entries["01"], entries[-1], entries[1.5], entries[4294967295]);
