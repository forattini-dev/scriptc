const response = new Response("native");
const headers = response.headers;

console.log(
  response instanceof Response,
  headers instanceof Headers,
  ({}) instanceof Response,
  ({}) instanceof Headers,
);
