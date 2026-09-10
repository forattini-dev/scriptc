// @rust-only
// @no-engine
type Message = { kind: "plain" | "note"; text: string } | { kind: "count"; text: string; count: number };
const messages = JSON.parse('[{"kind":"plain","text":"p","count":"extra"},{"kind":"count","text":"c","count":2},{"kind":"note","text":"n","count":9}]') as Message[];
for (const message of messages) {
  if (message.kind === "count") console.log("count", message.text, message.count);
  else console.log("plain", message.kind, message.text);
}
const nested = JSON.parse('{"item":{"kind":"plain","text":"nested","count":7}}') as { item: Message };
console.log("nested", nested.item.kind, nested.item.text);
const direct = JSON.parse('{"kind":"plain","text":"direct","count":4}') as Message;
console.log("direct", direct.kind, direct.text);
export {};
