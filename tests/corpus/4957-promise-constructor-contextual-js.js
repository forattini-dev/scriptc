// @rust-only
// @no-engine
/** @returns {Promise<string>} */
export async function value() {
  return new Promise((resolve) => {
    resolve("ready");
  });
}

void value().then((resolved) => console.log(resolved));
