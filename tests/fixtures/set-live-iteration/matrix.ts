for (let scenario = 0; scenario < 32; scenario++) {
  const values = new Set<number>();
  values.add(0);
  if (scenario % 4 !== 0) values.add(1);
  if (scenario % 4 >= 2) values.add(2);
  const visited: number[] = [];
  let steps = 0;
  for (const value of values) {
    visited.push(value);
    steps++;
    if (steps === 1) {
      switch (Math.floor(scenario / 4)) {
        case 0: values.add(3); break;
        case 1: values.delete(1); break;
        case 2: values.delete(value); break;
        case 3: values.delete(value); values.add(value); break;
        case 4: values.clear(); values.add(3); values.add(4); break;
        case 5: values.add(1); break;
        case 6: values.delete(1); values.add(1); break;
        case 7: values.add(3); values.delete(2); break;
      }
    }
    if (steps >= 8) break;
    if (scenario % 4 === 3 && value === 1) continue;
  }
  console.log(scenario, visited.join(','), values.size);
}
