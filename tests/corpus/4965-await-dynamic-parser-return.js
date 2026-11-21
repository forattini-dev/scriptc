// @rust-only
// @no-engine

/** @returns {Promise<any>} */
function erased() {
  return Promise.resolve("4.5");
}

async function parsed() {
  let enabled = false;
  if (!enabled) {
    enabled = true;
  }
  const value = await erased();
  return parseFloat(value);
}

void parsed().then((value) => console.log(value));
