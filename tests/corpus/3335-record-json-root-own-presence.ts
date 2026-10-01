// @rust-only
// @no-engine
const root = { a: 1, text: JSON.stringify(undefined) };
console.log(Object.keys(root).join(","), JSON.stringify(root));
console.log(Object.hasOwn(root, "text"), typeof root.text);
interface Optional { a: number; text?: string }
function explicit(): Optional { return { a: 1, text: undefined }; }
function omitted(): Optional { return { a: 1 }; }
const written = explicit();
const missing = omitted();
console.log(Object.keys(written).join(","), Object.hasOwn(written, "text"));
console.log(Object.keys(missing).join(","), Object.hasOwn(missing, "text"));
console.log(JSON.stringify(Object.values(written)), JSON.stringify(Object.values(missing)));
console.log(JSON.stringify(Object.entries(written)), JSON.stringify(Object.entries(missing)));
