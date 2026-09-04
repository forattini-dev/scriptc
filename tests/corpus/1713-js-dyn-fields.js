// Implicit-any class FIELDS in a JS class (ctor-assigned from untyped
// params — checked-dynamic slots): reads validate per use, compound
// assignments follow the dyn arithmetic stance (numeric ops check the
// number out and box back; `+=` with a string RHS is the string context),
// func-valued fields call through the dynCall boundary, typeof answers
// the boxed kind, and ++/-- check-and-box like the compound forms
// (postfix yields the old value, prefix the new).
'use strict';

class Bag {
  constructor(count, label, onEmpty) {
    this.count = count;
    this.label = label;
    this.onEmpty = onEmpty;
  }
  take(n) {
    this.count -= n;
    if (this.count <= 0) this.onEmpty(this.label);
    return this.count;
  }
  brand() {
    this.label += '!';
    return this.label;
  }
}

const bag = new Bag(5, 'marbles', (which) => console.log('empty:', which));
console.log('typeof count:', typeof bag.count, 'typeof label:', typeof bag.label);
console.log('take(2) →', bag.take(2));
console.log('brand →', bag.brand());
console.log('count * 10 =', bag.count * 10);
bag.count *= 2;
console.log('doubled:', bag.count);
console.log('take(6) →', bag.take(6));

// ++/-- over the dyn slot: postfix yields the OLD number, prefix the NEW,
// both box back into the field.
console.log(bag.count++);
console.log('after postfix:', bag.count);
console.log(++bag.count);
console.log(bag.count--);
console.log(--bag.count);
console.log('final:', bag.count);
