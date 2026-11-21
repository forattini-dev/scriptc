function inspect(value: any) {
  const json = JSON.stringify(value);
  try { return json.length + ':' + json.slice(0, 3) + ':' + json.includes('x'); }
  catch (error) { return 'caught:' + (error instanceof TypeError); }
}
console.log(inspect(undefined));
console.log(inspect('x🦊'));
console.log(inspect({ x: 1 }));
console.log(inspect(null));
