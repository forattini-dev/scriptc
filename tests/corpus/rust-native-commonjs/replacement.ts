import value from "./cjs/replace.js";
console.log("replacement", value.value, (value as any).original.old === "old", (value as any).original.late === "alias", (value as any).rebound === "rebound");
