// @rust-only
// @no-engine

import { ElementNode, TextNode } from "./html.js";
import type Node from "./node.js";

function count(nodes: Node[]): number {
  return nodes.length;
}

function hasParent(parent: ElementNode | null): boolean {
  return parent !== null;
}

const root = new ElementNode();
root.append(new TextNode("leaf"));
console.log(root.childNodes[0].text, count(root.childNodes), hasParent(null));
