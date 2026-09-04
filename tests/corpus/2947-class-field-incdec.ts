// Class field ++/-- in EXPRESSION position — the counter patterns a real
// CLI exercises. 700-classes-basic pins statement position; this pins the
// value: postfix yields the OLD field value, prefix the NEW, the receiver
// evaluates ONCE (and before the read), evaluation order is left-to-right
// across mixed operands, and checked-dynamic (implicit-any) fields follow
// the dyn arithmetic stance (check the number out, box the result back).
// Typed f64 fields and dyn fields, static and through base-typed slots.
// Node is the oracle.

class Counter {
  n: number;
  label: string;
  constructor(n: number, label: string) {
    this.n = n;
    this.label = label;
  }
  tick(): number {
    return this.n++;
  }
  reset(to: number): number {
    this.n = to;
    return --this.n;
  }
}

const c = new Counter(10, "c");
console.log(c.n++);
console.log(c.n);
console.log(++c.n);
console.log(c.n--);
console.log(--c.n);
console.log(c.n);

// Value positions: call arguments, array indices, assignment RHS.
const reads = [c.n++, ++c.n, c.n--];
console.log(reads, c.n);
const slots = [0, 0, 0];
let si = 0;
slots[si++] = c.n++;
console.log(slots, si, c.n);

// Receiver evaluation order: the receiver expression runs ONCE, before
// the field read — the side-effect log pins the order.
const log: string[] = [];
function pick(): Counter {
  log.push("pick");
  return c;
}
console.log(pick().n++);
console.log(log, c.n);
console.log(++pick().n);
console.log(log, c.n);

// Method-borne increments (the this receiver, statement and value).
console.log(c.tick(), c.tick(), c.tick(), c.n);
console.log(c.reset(5), c.n);

// Inherited field incremented through the derived type.
class Base {
  hits = 0;
}
class Derived extends Base {
  bump(): number {
    return this.hits++;
  }
}
const d = new Derived();
console.log(d.bump(), d.bump(), d.hits, ++d.hits);
