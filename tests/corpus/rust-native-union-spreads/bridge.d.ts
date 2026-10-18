export type Spec = { kind: "a"; text: string } | { kind: "b"; count: number };
export function pass(p: Spec): Spec;
export function inspect(p: Spec & { flag?: true }): string;
export function optionalCopy(p: { value: string }): { value?: string } | undefined;
