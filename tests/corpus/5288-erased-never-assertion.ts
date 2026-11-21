const CHANNELS = ["stable", "next"] as const;

function isChannel(value: unknown): boolean {
  return typeof value === "string" && CHANNELS.includes(value as never);
}

console.log(isChannel("stable"));
console.log(isChannel("other"));
console.log(isChannel(3));
