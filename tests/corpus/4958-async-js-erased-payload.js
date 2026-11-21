// @rust-only
// @no-engine
/** @param {*} value */
export async function choose(value) {
  return new Promise((resolve) => {
    resolve(value);
  });
}

void choose("ready").then((resolved) => console.log(resolved === "ready"));
