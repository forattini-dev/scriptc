let values = new Set([1, 2]);
let owners = 0;
function owner() { owners++; return values; }
for (const name of ['values', 'keys']) {
  values = new Set([1, 2]);
  const visited: number[] = [];
  owners = 0;
  if (name === 'values') {
    for (const value of owner().values()) {
      visited.push(value);
      if (value === 1) { values.delete(2); values.add(3); }
    }
  } else {
    for (const value of owner().keys()) {
      visited.push(value);
      if (value === 1) { values.delete(2); values.add(3); }
    }
  }
  console.log(name, owners, visited.join(','));
}
