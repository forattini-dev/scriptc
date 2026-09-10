// @rust-only
// @no-engine
import { create } from "./source.js";

type Counts = Record<string, { count: number }>;
interface Api {
  capture(values: Counts): Counts;
  current(): Counts;
  increment(): number;
}
const api: Api = create();
const values: Counts = { item: { count: 1 } };
const inner = values.item;
const captured = api.capture(values);
console.log("capture", captured === values, captured.item === inner, values.item.count);
inner.count = 5;
console.log("retained", api.current() === values, api.current().item === inner, api.increment(), captured.item.count);
captured.item = { count: 10 };
console.log("replace", api.current().item === captured.item, api.increment(), values.item.count, inner.count);
const fresh: Counts = { item: { count: 20 } };
console.log("recapture", api.capture(fresh) === fresh, api.current() === fresh, api.current() !== values);
console.log("separate", api.increment(), fresh.item.count, values.item.count);
