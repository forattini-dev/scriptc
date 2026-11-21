class Unrelated {
  map(callback) {
    return callback({ event: { id: 7 }, sourceAgent: "other" });
  }
}

function joinValues(array, separator = " | ") {
  return array.map((val) => (typeof val === "string" ? `'${val}'` : val)).join(separator);
}

console.log(joinValues(["a", 3]));
console.log(new Unrelated().map((value) => value.event.id));
