for (const value of [0, -0, 12, 1_234, -1_234, 1_234_567, NaN, Infinity, -Infinity]) {
  console.log(value.toLocaleString("en-US"));
}

for (const value of [12.5, 1_234_567.891, -98_765.432]) {
  console.log("default", value.toLocaleString());
}

for (const value of [1.0005, 999.9995, 0.00049, -0, 1e23, 1_234_567.891, NaN, Infinity]) {
  console.log("pt-BR", value.toLocaleString("pt-BR"));
}
