export function create() {
  let held = { item: { count: 0 } };
  return {
    capture(values) { held = values; values.item.count = values.item.count + 1; return values; },
    current() { return held; },
    increment() { held.item.count = held.item.count + 1; return held.item.count; },
  };
}
