// A second independent blocker: the fixpoint must move both modules in one round.
export const weird = new Proxy({ v: 1 }, {});
export function readWeird(): number {
  return (weird as { v: number }).v;
}
