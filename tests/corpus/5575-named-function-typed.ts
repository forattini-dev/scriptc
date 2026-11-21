const fact = function self(n: number): number { return n ? n * self(n - 1) : 1; };
console.log("typed", fact(6));
