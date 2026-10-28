import type { Writable } from 'node:stream';
export declare function toggle(force?: boolean, stream?: Writable): boolean;
export declare function isHidden(): boolean;
export declare const cursor: { toggle: typeof toggle; isHidden: typeof isHidden };
