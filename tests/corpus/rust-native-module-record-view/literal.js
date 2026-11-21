/** @typedef {{ type: string, props: any, children: any[] }} VNode */

/** @type {VNode} */
const EMPTY_VNODE = { type: "box", props: {}, children: [] };

function printSnapshot() {
  console.log(EMPTY_VNODE.type);
  console.log(EMPTY_VNODE.children.length);
  console.log(EMPTY_VNODE.props === EMPTY_VNODE.props);
}

printSnapshot();
