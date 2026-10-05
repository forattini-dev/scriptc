function check(array) {
  const child = (array[2] = { value: 1 });
  child.value = 8;
  console.log(array.length, 0 in array, 2 in array, child === array[2], array[2].value);
  console.log((array["length"] = 1), array.length, 2 in array);
  console.log((array[-0] = "zero"), array[0]);
  console.log((array[true] = "boolean"), array["true"]);
}
check([]);
