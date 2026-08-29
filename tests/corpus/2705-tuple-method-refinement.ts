type EventKind = "birth" | "death";

const eventKinds = [
  "birth",
  "death",
] as const as readonly ["birth", "death"] & {
  includes(searchElement: EventKind | "daemon"): boolean;
};

console.log(eventKinds.length, eventKinds[0], eventKinds[1]);
