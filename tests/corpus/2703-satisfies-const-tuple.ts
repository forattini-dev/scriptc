type EventKind = "birth" | "death";

const eventKinds = [
  "birth",
  "death",
] as const satisfies readonly EventKind[];

console.log(eventKinds.length, eventKinds[0], eventKinds[1]);
