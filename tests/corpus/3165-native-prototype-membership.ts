// @dynamic
const grab = (...args: any[]) => args[0];
const typed = { tag: 7 };
const proto = grab(typed);
const named = Object.create(proto);
const child: unknown = named;
const grandchild: unknown = Object.create(named);
function hasKey(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && key in value;
}
if (typeof child === 'object' && child !== null && typeof grandchild === 'object' && grandchild !== null) {
  console.log('tag' in child, Object.hasOwn(child, 'tag'), 'tag' in grandchild);
  console.log('added' in child, 'missing' in child);
  proto.added = undefined;
  console.log('added' in child, Object.hasOwn(child, 'added'), 'added' in grandchild);
  named.tag = 99;
  console.log('tag' in child, Object.hasOwn(child, 'tag'), Object.hasOwn(grandchild, 'tag'));
  named.ownUndefined = undefined;
  console.log('ownUndefined' in child, Object.hasOwn(child, 'ownUndefined'), 'ownUndefined' in grandchild);
  console.log(hasKey(child, 'tag'), hasKey(child, 'added'), hasKey(grandchild, 'ownUndefined'), hasKey(child, 'missing'));
}
