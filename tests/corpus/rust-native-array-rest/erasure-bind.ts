function combine(prefix: string, ...parts: string[]): string { return prefix + ":" + parts.join("|"); }
const erased: any = combine;
const back = erased as typeof combine;
console.log(erased("any", "a", "b") === "any:a|b", back("typed", "c"));
const bound = combine.bind(null, "bound");
console.log("bound", bound(), bound("a", "b"), bound === bound);
const ordinary = (parts: string[]) => parts.join("|");
const variadic = (...parts: string[]) => parts.join("|");
console.log("abi", ordinary(["array"]), variadic("a", "b"));
let current: typeof combine | undefined = combine;
function replace(): string { current = (prefix: string, ...parts: string[]) => "new:" + prefix + parts.join("|"); return "argument"; }
console.log("snapshot", current("old", replace()), current("next", "x"));
