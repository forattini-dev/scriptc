export interface Options { width?: number; }
export declare function plan(options?: Options & { height?: number }): number;
export declare const renderer: { transmit(options?: Options): number; };
