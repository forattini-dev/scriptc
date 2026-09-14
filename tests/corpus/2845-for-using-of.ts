const events: string[] = [];

class Resource {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  [Symbol.dispose](): void {
    events.push("close " + this.name);
  }
}

const resources = [new Resource("first"), new Resource("second"), new Resource("third")];
for (using resource of resources) {
  events.push("use " + resource.name);
  if (resource.name === "first") continue;
  if (resource.name === "second") break;
}

console.log(events.join(" | "));
