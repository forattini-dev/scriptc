async function fetchWrapper() {
  return { data: "ready" };
}

/** @type {Promise<any>} */
const erased = fetchWrapper();
/** @type {Promise<{data: string}>} */
const typed = fetchWrapper();

console.log(true);
export {};
