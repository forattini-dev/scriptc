// @tsc-decorators
interface Presence {
  readonly kind: string;
  readonly pid: number;
}

class UnreachableError extends Error {
  constructor(
    readonly socketPath: string,
    readonly presence?: Presence,
  ) {
    super(`unreachable: ${socketPath}`);
    this.name = "UnreachableError";
  }
}

class HeldError extends UnreachableError {
  constructor(
    socketPath: string,
    override readonly presence: Presence,
  ) {
    super(socketPath, presence);
    this.name = "HeldError";
  }
}

const held = new HeldError("/tmp/agent.sock", { kind: "held", pid: 42 });
const reachableView: UnreachableError = held;
console.log(
  held.name,
  held.message,
  held.socketPath,
  held.presence.kind,
  held.presence.pid,
  reachableView.presence?.kind ?? "none",
  held instanceof HeldError,
  held instanceof UnreachableError,
  held instanceof Error,
);
