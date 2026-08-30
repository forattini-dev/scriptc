interface Presence {
  kind: "booting" | "held-unresponsive";
  holder: { pid: number } | null;
}

class AgentUnreachableError extends Error {
  readonly socketPath: string;
  readonly presence?: Presence;

  constructor(socketPath: string, presence?: Presence) {
    super(`unreachable: ${socketPath}`);
    this.socketPath = socketPath;
    this.presence = presence;
    this.name = "AgentUnreachableError";
  }
}

function describe(value: unknown): string {
  if (!(value instanceof AgentUnreachableError)) return "other";
  const holder =
    value.presence?.kind === "held-unresponsive"
      ? value.presence.holder
      : null;
  return `${value.socketPath}:${holder?.pid ?? 0}`;
}

console.log(describe(new AgentUnreachableError("/tmp/boot.sock")));
console.log(
  describe(
    new AgentUnreachableError("/tmp/held.sock", {
      kind: "held-unresponsive",
      holder: { pid: 4242 },
    }),
  ),
);
console.log(describe(new Error("plain")));
