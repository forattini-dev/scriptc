function parity(n: number): string {
  const result = even(n);

  function even(k: number): string {
    if (k === 0) return "even";
    return odd(k - 1);
  }

  function odd(k: number): string {
    if (k === 0) return "odd";
    return even(k - 1);
  }

  return result;
}

console.log(parity(8), parity(7));

function threeWay(n: number): string {
  function first(k: number): string {
    if (k === 0) return "first";
    return second(k - 1);
  }

  function second(k: number): string {
    if (k === 0) return "second";
    return third(k - 1);
  }

  function third(k: number): string {
    if (k === 0) return "third";
    return first(k - 1);
  }

  return `${first(n)},${second(n)},${third(n)}`;
}

console.log(threeWay(5));
