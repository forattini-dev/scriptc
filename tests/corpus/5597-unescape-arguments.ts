// @ts-nocheck
const events: string[] = [];
function side(): string { events.push("extra"); return "unused"; }
console.log("missing", unescape());
console.log("extra", unescape("%41", side()), events.join(","));
try { unescape(Symbol("x"), side()); } catch (error) { console.log("symbol", error.name, events.join(",")); }
