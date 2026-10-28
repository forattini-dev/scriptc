export function toggle(force, stream) {
  return force === true || (force === undefined && stream !== undefined);
}
export function isHidden() { return false; }
export const cursor = { toggle, isHidden };
