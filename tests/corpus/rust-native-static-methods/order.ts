// @ts-nocheck
function mark(): number { console.log('argument'); return 1; }
try {
  Later.run(mark());
} catch {
  console.log('tdz');
}
class Later { static run(value: number): number { return value; } }
console.log('after', Later.run(3));
