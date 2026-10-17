var ResponseError = class extends Error {
  constructor(request, response) {
    super(`response error`);
    this.request = request;
    this.response = response;
    this.data = response.data;
    this.errors = response.errors;
  }
  request;
  response;
  data;
  errors;
  name = "ResponseError";
};
export { ResponseError };
