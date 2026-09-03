const controller = new AbortController();
const seen: string[] = [];

controller.signal.addEventListener("abort", () => seen.push("first"));
controller.signal.addEventListener("abort", () => seen.push("second"));
controller.abort();

console.log(seen.join(","));
