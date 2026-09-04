// The minimal JSX runtime surface the checker's element typing needs:
// IntrinsicElements must exist for <h1> to type, and the factory the
// jsxImportSource names must have a callable shape. Type-only — the
// element tree keeps its lowering fence.
declare namespace JSX {
  interface IntrinsicElements {
    h1: { [key: string]: unknown };
    [name: string]: { [key: string]: unknown };
  }
  // A statically-representable stand-in: the fence names the element
  // tree, not the value world.
  type Element = string;
}
export function jsx(tag: string, props: Record<string, unknown>): unknown;
export function jsxs(tag: string, props: Record<string, unknown>): unknown;
export function Fragment(props: { children?: unknown }): unknown;
