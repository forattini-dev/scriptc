import type { ElementNode } from "./html.js";

export default abstract class Node {
  public childNodes = [] as Node[];
  public parentNode = null as ElementNode | null;
  abstract text: string;

  append(child: Node): void {
    this.childNodes.push(child);
  }
}
