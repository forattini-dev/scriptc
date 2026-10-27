// @rust-only
// @no-engine
import {first,second,clear,readType} from "./module.ts";
console.log("module",first,second,readType());
clear();
console.log("live",first,readType());
