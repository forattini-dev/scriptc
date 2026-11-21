export function normalizeChildren(children) {
  if (children === null || children === undefined || children === false || children === true) {
    return [];
  }
  if (Array.isArray(children)) {
    return children.flatMap(normalizeChildren);
  }
  if (typeof children === 'string' || typeof children === 'number') {
    return [{ type: 'text', props: { children: String(children) }, children: [] }];
  }
  return [children];
}
