// @rust-only
// @no-engine
// @ts-nocheck
"use strict";
const normal = function(label) { console.log("strict", label === "null", this === null, this === undefined, typeof this); };
normal.call(null, "null");
normal.call(1, "number");
normal("bare");
const maker = function() { return () => this; };
const receiver = { value: 1 };
const arrow = maker.call(receiver);
console.log("lexical", arrow() === receiver, arrow.call(null) === receiver);
