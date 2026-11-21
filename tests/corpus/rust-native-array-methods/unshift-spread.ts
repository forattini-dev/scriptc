const values = ["later"];
console.log(values.unshift("first", ...values));
console.log(values.join(","));

const pending = ["a", "b"];
const healed = ["c"];
console.log(healed.unshift(...pending));
console.log(healed.join(","));
