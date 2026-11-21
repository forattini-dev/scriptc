export interface VNode { type: string; props: Record<string, any>; children: VNode[] }
export type TuiChild = VNode | string | number | boolean | null | undefined;
export type TuiNode = TuiChild | TuiChild[];
export function normalizeChildren(children: TuiNode): VNode[];
