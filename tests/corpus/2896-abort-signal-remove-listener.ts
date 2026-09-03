const controller = new AbortController();
const seen: string[] = [];

function removed(): void {
  seen.push("removed");
}

controller.signal.addEventListener("abort", removed);
controller.signal.removeEventListener("abort", removed);
controller.signal.addEventListener("abort", () => seen.push("kept"));
controller.abort();

console.log(seen.join(","));
