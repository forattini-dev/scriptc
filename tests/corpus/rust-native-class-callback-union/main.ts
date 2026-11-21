interface FilterExpression { and?: FilterExpression[]; eq?: [string, unknown] }
class FilterBuilder { parts: string[] = []; eq(a: string, b: string): this { this.parts.push(`${a} eq ${b}`); return this; } build(): string { return this.parts.join(" and "); } }
class Query {
  options: { $filter?: string | FilterExpression } = {};
  filter(filter: string | FilterExpression | ((builder: FilterBuilder) => FilterBuilder)): this {
    if (typeof filter === "function") {
      const builder = new FilterBuilder();
      this.options.$filter = filter(builder).build();
    } else {
      this.options.$filter = filter;
    }
    return this;
  }
}
console.log(JSON.stringify(new Query().filter((b) => b.eq("a", "1")).options));
console.log(JSON.stringify(new Query().filter("x eq 2").options));
console.log(JSON.stringify(new Query().filter({ eq: ["y", 3] }).options));

class Point { readonly x: number; constructor(x: number) { this.x = x; } }
function make(factory: () => Point): number { return factory().x * 2; }
console.log(make(() => new Point(21)));
