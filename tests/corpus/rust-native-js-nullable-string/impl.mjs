export function check(value) {
  if (!value) return false;
  return value.startsWith("-");
}

export function unsafe(value, extra) {
  return value.startsWith(extra());
}
