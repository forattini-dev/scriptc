export interface VNode {
  type: string;
  children: VNode[];
}
export type Child = VNode | string | number | boolean | null | undefined;
export type Node = Child | Child[];
export declare function normalizeChildren(children: Node): VNode[];
