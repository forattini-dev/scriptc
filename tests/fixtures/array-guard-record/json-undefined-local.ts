const values = JSON.parse('[]') as string[];
try {
  const json = JSON.stringify(values[0]);
  console.log(typeof json);
} catch (error) {
  console.log('caught', error instanceof TypeError);
}
