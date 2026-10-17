// @rust-only
// @no-engine
class Packet { value: number; constructor(value: number) { this.value = value; } }
const packet = new Packet(42);
try { throw packet; } catch (caught) {
  console.log("caught", caught instanceof Packet, caught instanceof Error);
  if (caught instanceof Packet) console.log("value", caught.value, caught === packet);
}
let effects = 0;
function field(): number { effects = effects + 1; throw new TypeError("field failed"); }
class Broken { value = field(); constructor() { console.log("must not run"); } }
try { new Broken(); } catch (caught) {
  if (caught instanceof TypeError) console.log("field error", caught.message, effects);
} finally { console.log("finally"); }
class Standalone { value = 23; }
try { throw new Standalone(); } catch (caught) {
  if (caught instanceof Standalone) console.log("standalone catch", caught.value);
}
const Expression = class extends Packet {};
const expression = new Expression(9);
console.log("expression", expression.value, expression instanceof Packet, expression instanceof Expression);
