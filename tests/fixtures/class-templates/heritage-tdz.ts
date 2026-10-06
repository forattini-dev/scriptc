class Base { v: number; constructor(v: number) { this.v = v; } }
function make(tag: string) { const Made = class extends Base { tag(): string { return tag; } }; return Made; }
function current() { return Late; }
console.log("before");
class Early extends current() {}
const Late = make("late");
console.log(new Early(1).tag());
