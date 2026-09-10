export function createCounter() {
  let total = 0;
  return {
    push(value) { total += value; return total; },
    end() { return total; },
  };
}
export function identity(value) { return value; }
export function sameObject(left, right) { return left === right; }
export function inspect(counter) { return counter.push(7); }
export function replace(counter) { counter.push = (value) => value * 10; }
export function invalidate(counter) { counter.push = 42; }
