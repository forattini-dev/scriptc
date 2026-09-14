const events: string[] = [];

class Resource {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
    events.push("open " + name);
  }

  [Symbol.dispose](): void {
    events.push("close " + this.name);
  }
}

{
  using first = new Resource("first");
  using second = new Resource("second");
  events.push("body");
}

function throughReturn(): string {
  using returned = new Resource("return");
  events.push("return body");
  return "returned";
}

for (let i = 0; i < 3; i = i + 1) {
  using loop = new Resource("loop " + i);
  if (i === 0) continue;
  if (i === 1) break;
}

{
  using nothing = null;
  events.push(String(nothing));
}

console.log(throughReturn());
console.log(events.join(" | "));
