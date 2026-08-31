// @dynamic
const values = JSON.parse('[1234567.891,0]');
values[1] = -0;

console.log(values[0].toLocaleString("en-US"), values[1].toLocaleString("en-US"));
