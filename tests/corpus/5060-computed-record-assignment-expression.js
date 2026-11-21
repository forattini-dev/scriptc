const result = { alpha: "old", beta: "old" };
/** @type {"alpha" | "beta"} */
const category = "alpha";
console.log((result[category] = "new") === "new");
console.log(result.alpha);
