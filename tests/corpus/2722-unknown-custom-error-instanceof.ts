class AgentUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnreachableError";
  }
}

class AgentHeldError extends AgentUnreachableError {
  constructor(message: string) {
    super(message);
    this.name = "AgentHeldError";
  }
}

function printErrorKinds(value: unknown): void {
  console.log(
    value instanceof AgentHeldError,
    value instanceof AgentUnreachableError,
    value instanceof Error,
    value instanceof TypeError,
  );
}

printErrorKinds(new AgentHeldError("held"));
printErrorKinds(new AgentUnreachableError("unreachable"));
printErrorKinds(new Error("plain"));
printErrorKinds(new TypeError("typed"));
printErrorKinds("not an error");
