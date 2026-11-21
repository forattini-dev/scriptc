import Limiter from './limiter.cjs';

const limiter = new Limiter();
const on = limiter.on;
console.log(on === limiter.on, limiter.on('ready', value => value));
