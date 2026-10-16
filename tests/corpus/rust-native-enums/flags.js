console.log("enum before", DirtyFlags === undefined);
export var DirtyFlags;
(function (DirtyFlags) {
    DirtyFlags[DirtyFlags["NONE"] = 0] = "NONE";
    DirtyFlags[DirtyFlags["CONTENT"] = 1] = "CONTENT";
    DirtyFlags[DirtyFlags["LAYOUT"] = 2] = "LAYOUT";
    DirtyFlags[DirtyFlags["STYLE"] = 4] = "STYLE";
    DirtyFlags["LABEL"] = "dirty";
})(DirtyFlags || (DirtyFlags = {}));
export const original = DirtyFlags;
(function (DirtyFlags) {
    DirtyFlags[DirtyFlags["CHILDREN"] = 8] = "CHILDREN";
    DirtyFlags[DirtyFlags["FORCE_FULL"] = 16] = "FORCE_FULL";
    DirtyFlags[DirtyFlags["NEGATIVE"] = -1] = "NEGATIVE";
    DirtyFlags[DirtyFlags["ALIAS"] = 1] = "ALIAS";
})(DirtyFlags || (DirtyFlags = {}));
export function content() { return DirtyFlags.CONTENT; }
