const receiver = { prefix: "native" };

function format(this: { prefix: string }, left: string, right: number): string {
  return `${this.prefix}:${left}:${right}`;
}

const values: [string, number] = ["apply", 7];
console.log(Reflect.apply(format, receiver, values));
