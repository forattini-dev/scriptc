export declare enum DirtyFlags { NONE = 0, CONTENT = 1, LAYOUT = 2, STYLE = 4, CHILDREN = 8, FORCE_FULL = 16, NEGATIVE = -1, ALIAS = 1, LABEL = "dirty" }
export declare const original: typeof DirtyFlags;
export declare function content(): number;
