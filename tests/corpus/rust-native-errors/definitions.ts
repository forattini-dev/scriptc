export class SyntaxFault extends SyntaxError {
  readonly items: string[];
  constructor(message: string, items: string[]) {
    super(message);
    this.name = "SyntaxFault";
    this.items = items;
  }
}
// Neither these instance initializers nor this body runs at definition time.
// They remain typechecked, but need no native layout/constructor until demanded.
export class UnusedError extends Error {
  context: unknown;
  constructor(context: unknown) {
    super("unused");
    this.context = context;
    while (false) console.log("never");
  }
}
