// Array-derived class receivers keep their possible missing value until
// method lookup. Present values dispatch directly or virtually, while a
// missing receiver throws before method arguments execute, exactly like JS.
class Leaf {
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  show(suffix: string): string {
    return `${this.name}:${suffix}`;
  }
}

class Base {
  protected readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  show(suffix: string): string {
    return `base:${this.name}:${suffix}`;
  }
}

class Derived extends Base {
  show(suffix: string): string {
    return `derived:${this.name}:${suffix}`;
  }
}

const leaves: Leaf[] = [new Leaf("leaf")];
const bases: Base[] = [new Base("plain"), new Derived("child")];
console.log(leaves[0].show("direct"));
console.log(bases[0].show("virtual"));
console.log(bases[1].show("virtual"));

let argumentEffects = 0;
try {
  leaves[4].show((argumentEffects++, "missing"));
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
console.log(argumentEffects);

class MaybeValue {
  read(present: boolean): string | undefined {
    if (present) return "present";
  }
}

const maybeValue = new MaybeValue();
console.log(maybeValue.read(true), maybeValue.read(false) ?? "missing");
