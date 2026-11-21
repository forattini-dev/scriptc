import Limiter from './limiter.cjs';

const first = new Limiter(7);
const Alias = Limiter;
const second = new Alias(9);

console.log(first.read(), second.read(), Alias === Limiter);
