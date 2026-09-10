// @dynamic
import { collectTwice, rows, record } from "typedinputs";

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
console.log(collectTwice(collect));

function summarize(values: { name: string; tags: number[] }[]): string[] {
  return values.map(value => `${value.name}:${value.tags.join("-")}`);
}
console.log(rows(summarize));

function describe(value: { title: string; values: number[] }): string[] {
  return [value.title, value.values.join(",")];
}
console.log(record(describe));
