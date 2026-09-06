// The island module (Proxy keeps it there): the invocation record a CLI
// entry switches on — red-dev's shape.
const guard = new Proxy({ on: true }, {});
export interface Invocation {
  command: string | null;
  action: "theme" | "wallpaper" | "doctor";
  count: number;
}
export function parse(argv: string[]): Invocation {
  const command = argv[0] ?? null;
  return { command, action: argv.length > 1 ? "wallpaper" : "theme", count: argv.length + ((guard as { on: boolean }).on ? 0 : 1) };
}
