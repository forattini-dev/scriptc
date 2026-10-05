// Redeclaring an inherited field WITH an initializer: Node [[Define]]s the
// own property again after super(), so the base slot takes the new value at
// the subclass's field-init position — the pattern's errors.js idiom on the
// builtin Error prefix, and the plain program-class shape. Bare redeclares
// of non-nullable slots and type-changing redeclares keep their fence.
class ConfigError extends Error {
  name = "ConfigError";
}
class UndefinedParserError extends Error {
  name = "UndefinedParserError";

  constructor(parser: string) {
    super(`no parser for ${parser}`);
  }
}
class A {
  tag = "a";
  n = 1;
  describe(): string {
    return `${this.tag}:${this.n}`;
  }
}
class B extends A {
  tag = "b";
}

const e = new ConfigError("boom");
console.log(e.name, e.message, String(e), e instanceof Error, e instanceof ConfigError);
try {
  throw new UndefinedParserError("mystery");
} catch (err) {
  console.log((err as Error).name, (err as Error).message);
}
const b = new B();
const a: A = b;
console.log(b.tag, a.tag, b.describe(), a.n);
