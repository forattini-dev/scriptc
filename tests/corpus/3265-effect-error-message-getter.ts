// @rust-only
// Schema error classes whose `message` is a getter (no `message` prop): the
// kernel constructs no own message, so every read answers the getter —
// through the class type, the Error type, String(), templates, and caught
// narrowing — while error classes without a getter keep the empty slot.
import { Schema } from "effect";

class CommandFailed extends Schema.TaggedErrorClass<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
}) {
  override get message(): string {
    const status = this.exitCode === undefined ? "" : ` (exit ${this.exitCode})`;
    return `Command failed${status}: ${this.command}`;
  }
}

class Timeout extends Schema.TaggedErrorClass<Timeout>()("Timeout", { ms: Schema.Number }) {}

const failed = new CommandFailed({ command: "ls", exitCode: 2 });
const plain = new CommandFailed({ command: "sleep" });
console.log(failed.message);
console.log(plain.message, plain._tag, plain.name);

const asError: Error = failed;
console.log(asError.message);
console.log(String(failed));
console.log(`${plain}`);
console.log(JSON.stringify(new Timeout({ ms: 5 }).message));

const errors: Error[] = [plain, new Timeout({ ms: 1 }), new Error("boom")];
for (const error of errors) console.log(error.name, JSON.stringify(error.message));

try {
  throw failed;
} catch (error) {
  if (error instanceof CommandFailed) console.log("caught", error.message, error.exitCode);
  if (error instanceof Error) console.log("as error", error.message);
}
