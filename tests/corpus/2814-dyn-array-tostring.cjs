// @dynamic
const values = JSON.parse('[1,"x",null,[2,3],0]');
values[4] = undefined;

console.log(values.toString());
