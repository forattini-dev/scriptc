interface CommandSpec {
  aliases?: string[];
}

interface RouterSchema<C extends string> {
  commands: Record<C, CommandSpec>;
  default: C;
}

function routeCommand<C extends string>(
  argv: readonly string[],
  schema: RouterSchema<C>,
): { command: C; args: string[] } {
  const [first, ...rest] = argv;
  if (first !== undefined) {
    for (const [name, spec] of Object.entries(schema.commands) as [C, CommandSpec][]) {
      if (first === name || (spec.aliases ?? []).includes(first)) {
        return { command: name, args: rest };
      }
    }
  }
  return { command: schema.default, args: [...argv] };
}

type Command = "run" | "status";
const schema: RouterSchema<Command> = {
  commands: {
    run: { aliases: ["r"] },
    status: { aliases: ["s"] },
  },
  default: "run",
};

console.log(JSON.stringify(routeCommand(["r", "one"], schema)));
console.log(JSON.stringify(routeCommand(["status", "two"], schema)));
console.log(JSON.stringify(routeCommand(["--json"], schema)));
