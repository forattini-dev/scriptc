// @ts-nocheck
const error = Object.assign(new Error("limited"), {
  response: { status: 429 },
  data: { retry: true },
});

console.log(error.message);
console.log(`${error.response.status}`);
