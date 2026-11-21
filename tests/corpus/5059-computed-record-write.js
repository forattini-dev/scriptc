const result = { alpha: "old", beta: "old" };
/** @type {Set<"alpha" | "beta">} */
const categories = new Set(["alpha", "beta"]);
for (const category of categories) {
  result[category] = "new";
}
console.log(result.alpha);
console.log(result.beta);
