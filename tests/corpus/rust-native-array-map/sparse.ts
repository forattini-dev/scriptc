// Exercise a matrix of initial holes and changes made by the first callback.
// Every case records both the visited indices and the result's own indices.
for (let shape = 0; shape < 8; shape++) {
  for (let change = 0; change < 4; change++) {
    const values: any[] = [10, 20, 30, 40, 50];
    if ((shape & 1) !== 0) delete values[0];
    if ((shape & 2) !== 0) delete values[2];
    if ((shape & 4) !== 0) values.length = 7;
    const visited: string[] = [];
    const mapped = values.map((value, index, array) => {
      visited.push(`${index}:${value}`);
      if (visited.length === 1) {
        if (change === 0) delete array[3];
        if (change === 1) array[2] = 99;
        if (change === 2) array.push(60);
        if (change === 3) array.length = 2;
      }
      return value + index;
    });
    console.log(shape, change, visited.join(','), mapped.length,
      Object.keys(mapped).join(','), JSON.stringify(mapped));
  }
}

// An explicit undefined is present and must be visited, unlike a hole.
const optional: any[] = [1, undefined, 3, 4];
delete optional[2];
const optionalVisited: string[] = [];
const optionalMapped = optional.map((value, index) => {
  optionalVisited.push(`${index}:${typeof value}`);
  return value === undefined ? undefined : value * 2;
});
console.log('undefined', optionalVisited.join(','), optionalMapped.length,
  Object.keys(optionalMapped).join(','), JSON.stringify(optionalMapped));

// A typed array can also acquire holes when its length grows. Filling a
// future slot during the callback must make that slot visible to map.
const typed = [1, 2];
typed.length = 5;
const typedVisited: string[] = [];
const typedMapped = typed.map((value, index, array) => {
  typedVisited.push(`${index}:${value}`);
  if (index === 0) array[3] = 7;
  return String(value + index);
});
console.log('typed', typedVisited.join(','), typedMapped.length,
  Object.keys(typedMapped).join(','), JSON.stringify(typedMapped));
