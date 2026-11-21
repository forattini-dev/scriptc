type Level = "lossless" | "brief" | "terse" | (string & {});

function label(level: Level): string {
  return level === "terse" ? "short" : level;
}

console.log(label("terse"), label("custom"));
