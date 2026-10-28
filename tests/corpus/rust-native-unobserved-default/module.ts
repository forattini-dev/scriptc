console.log('before');
export let value = 1;
function make(): { value: number } {
  console.log('default evaluated', value);
  return { value };
}
export default make();
value = 2;
console.log('after', value);
