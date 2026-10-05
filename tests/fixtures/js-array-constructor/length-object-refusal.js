const array = new Array(0);
function length() {
  return 3;
}
array.length = { valueOf: length };
console.log(array.length);
