export interface Row { name: string; children?: Tree; childTable?: Record<string, Tree>; self?: Tree; }
export type Tree = Row | undefined;
export declare function parse(value: string): number;
export declare function tree(): Tree;
