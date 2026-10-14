interface Change { body: string; files: string[] }
interface Published extends Change { authors: string[]; pullRequests: number[] }
function publish(input: { changes: Published[] }): Published[] { return input.changes; }
const files = ["one"];
const changes: Change[] = [{ body: "note", files }, { body: "more", files }];
const result = publish({ changes: changes.map(change => ({ ...change, authors: [], pullRequests: [] })) });
result[0]!.authors.push("alice");
result[1]!.authors.push("bob");
result[0]!.pullRequests.push(7);
files.push("two");
console.log(result[0]!.authors.join(","), result[1]!.authors.join(","), result[0]!.pullRequests.join(","));
console.log(result[0]!.files === files, result[1]!.files === files, result[0]!.files.join(","));
const nested: string[][] = [1, 2].map(() => []);
nested[0]!.push("fresh");
console.log(nested[0]!.join(","), nested[1]!.length, nested[0] === nested[1]);
const held: string[] = [];
const shared: { authors: string[] }[] = [1, 2].map(() => ({ authors: held }));
shared[0]!.authors.push("shared");
console.log(shared[1]!.authors.join(","), shared[0]!.authors === held, shared[1]!.authors === held);
