interface LogLine {
  readonly at: number;
  readonly text: string;
}

const lines = new Map<string, LogLine>();
lines.set("worker-b", { at: 2, text: "started" });
lines.set("worker-a", { at: 1, text: "ready" });
lines.set("worker-b", { at: 3, text: "restarted" });

const snapshot = Object.fromEntries(lines);
console.log(JSON.stringify(snapshot));
console.log(Object.keys(snapshot).join(","), snapshot["worker-a"] === lines.get("worker-a"));

const counts = new Map<string, number>([["x", 1], ["y", 2]]);
console.log(JSON.stringify(Object.fromEntries(counts)));
console.log(JSON.stringify(Object.fromEntries(new Map<string, string>())));
