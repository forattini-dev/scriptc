// @ts-nocheck
import { target, original } from "./function-assign-source.ts";
const decorated = Object.assign(target, { marker: "module" });
console.log("module", original === decorated, target === decorated, decorated(4), original.marker as string);
