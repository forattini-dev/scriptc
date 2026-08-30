class AgentUnreachableError extends Error {
  readonly socketPath: string;

  constructor(socketPath: string) {
    super(`unreachable: ${socketPath}`);
    this.socketPath = socketPath;
    this.name = "AgentUnreachableError";
  }
}

const original = new AgentUnreachableError("/tmp/redskilled.sock");
const wrapped = new Error("reconnect exhausted", { cause: original });

console.log(wrapped.cause instanceof AgentUnreachableError);
if (wrapped.cause instanceof AgentUnreachableError) {
  console.log(wrapped.cause.socketPath);
}
