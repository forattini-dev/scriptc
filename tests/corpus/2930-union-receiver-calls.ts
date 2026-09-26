// Calls through class and array unions dispatch on the runtime arm without
// copying receivers. Array HOF adapters preserve holes, callback-array
// identity, mutation timing, and receiver-before-argument evaluation.
class Left {
  value: number;

  constructor(value: number) {
    this.value = value;
  }

  leftOnly(): string {
    return "left-only";
  }

  describe(prefix = "left"): string {
    return `${prefix}:L${this.value}`;
  }

  mixed(): number {
    return this.value * 10;
  }
}

class Right {
  value: number;

  constructor(value: number) {
    this.value = value;
  }

  rightOnly(): string {
    return "right-only";
  }

  describe(prefix = "right"): string {
    return `${prefix}:R${this.value}`;
  }

  mixed(): string {
    return `R${this.value}`;
  }
}

function values(which: boolean): Left[] | Right[] {
  if (which) return [new Left(1), new Left(2), new Left(3)];
  const out: Right[] = [];
  out.length = 3;
  out[1] = new Right(4);
  return out;
}

function show(value: Left | Right): void {
  console.log(value.describe(), value.describe("set"), value.mixed());
}

show(new Left(5));
show(new Right(6));

class LeftBase {
  leftBaseOnly(): boolean {
    return true;
  }

  speak(word: string): string {
    return `LB:${word}`;
  }
}

class LeftChild extends LeftBase {
  speak(word: string): string {
    return `LC:${word}`;
  }
}

class RightBase {
  rightBaseOnly(): boolean {
    return true;
  }

  speak(word: string): string {
    return `RB:${word}`;
  }
}

class RightChild extends RightBase {
  speak(word: string): string {
    return `RC:${word}`;
  }
}

function speak(value: LeftBase | RightBase): string {
  return value.speak("hello");
}

console.log(speak(new LeftBase()), speak(new LeftChild()));
console.log(speak(new RightBase()), speak(new RightChild()));

function inspect(items: Left[] | Right[], mutate: () => void): void {
  const seen: string[] = [];
  let mutated = false;
  const mapped = items.map((item, index, array) => {
    seen.push(`${index}:${array === items}:${item.describe("map")}`);
    if (!mutated) {
      mutated = true;
      mutate();
    }
    return item.value + index;
  });
  const each: string[] = [];
  items.forEach((item, index, array) => {
    each.push(`${index}:${array === items}:${item.describe("each")}`);
  });
  console.log(seen.join("|"));
  console.log(mapped.length, 0 in mapped, 1 in mapped, 2 in mapped, mapped.join(","));
  console.log(each.join("|"));
}

const left = values(true) as Left[];
inspect(left, () => {
  left.pop();
});
const right = values(false) as Right[];
inspect(right, () => {});

const order: string[] = [];
function orderedReceiver(): Left[] | Right[] {
  order.push("receiver");
  return values(true);
}
function orderedCallback(): (item: Left | Right) => number {
  order.push("callback");
  return (item) => item.value;
}
console.log(orderedReceiver().map(orderedCallback()).join(","));
console.log(order.join(","));
