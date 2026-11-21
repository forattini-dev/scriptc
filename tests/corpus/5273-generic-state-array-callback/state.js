export function useState(initial) {
  let value = initial;
  const getter = () => value;
  const setter = (next) => {
    value = typeof next === "function" ? next(value) : next;
  };
  return [getter, setter];
}
