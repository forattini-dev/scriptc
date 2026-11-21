// @ts-nocheck
export function normalizeChildren(children) {
  if (Array.isArray(children)) {
    return children.flatMap(normalizeChildren);
  }
  return [{ type: String(children), children: [] }];
}
