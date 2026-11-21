class Holder {
  table = new WeakMap<object, number>();
}
export function factory(): { holder: Holder } {
  return { holder: new Holder() };
}
