export interface Scope { id: number; resources: Map<symbol, unknown> }
export declare function choose(explicit?: Scope): Scope;
export declare function chooseBlock(explicit?: Scope): Scope;
export declare function select(active: Scope | null, fallback: Scope): Scope;
export declare function unstable(explicit?: Scope): Scope | undefined;
