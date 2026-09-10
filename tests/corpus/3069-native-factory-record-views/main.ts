// @rust-only
// @no-engine
import { createEmitter, captureWith, replaceCapture } from "./source.js";
type Value = boolean | number | null | string;
type Row = Record<string, Value>;
interface Emitter {
  capture(row: Row): Row;
  current(): Row;
  set(key: string, value: string): void;
  matches(row: Row): boolean;
  reset(): Row;
}
const emitter: Emitter = createEmitter();
const row: Row = { count: 1, active: true, empty: null };
const captured = emitter.capture(row);
console.log("identity", row === captured, emitter.current() === row, emitter.matches(row));
row.count = 2;
emitter.set("label", "library");
console.log("writes", JSON.stringify(row), captured.count);
captured.active = false;
delete captured.empty;
console.log("keys", Object.keys(row).join(","), JSON.stringify(emitter.current()));
const fresh = emitter.reset();
const alias = emitter.current();
console.log("reset", fresh === alias, fresh !== row, emitter.matches(fresh));
fresh.count = 4;
console.log("returned write", alias.count);
replaceCapture(emitter);
console.log("replacement", emitter.capture(fresh) === fresh, fresh.label);
emitter.capture = (value: Row): Row => { value.label = "callback"; return value; };
const callbackResult: Row = captureWith(emitter, alias);
console.log("callback", callbackResult === fresh, fresh.label);
function box(value: Row): unknown { return value; }
function unbox(value: unknown): Row { return value as Row; }
console.log("round trip", unbox(box(row)) === row, box(row) === box(row));
const parsed: unknown = JSON.parse('{"name":"parsed","2":2,"1":1}');
const view = unbox(parsed);
const second = unbox(parsed);
console.log("parsed", view === second, box(view) === parsed, Object.keys(view).join(","));
view.name = "changed";
console.log("parsed write", JSON.stringify(parsed));
console.log("absent", view.missing);
