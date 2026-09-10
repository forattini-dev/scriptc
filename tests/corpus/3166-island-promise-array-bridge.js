// @dynamic
/** @returns {any} */
function mintLoader() {
  return {
    /** @returns {Promise<any>} */
    one: async (x) => ({ got: `${x}` }),
  };
}
const loader = mintLoader();
function loadAll(xs = []) {
  return Promise.all(xs.map((x) => loader.one(x)));
}
async function main(...args) {
  const got = await loadAll(['a', 'b']);
  console.log(`all ${got.length} ${got[0].got} ${got[1].got}`);
  const empty = await loadAll();
  console.log(`empty ${empty.length}`);
}
void main();
