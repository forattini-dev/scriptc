class RequestError extends Error {
  request: { request: { retries: number } };

  constructor(
    message: string,
    request: { request: { retries: number } },
  ) {
    super(message);
    this.request = request;
  }
}

function retries(error: RequestError): number {
  return error?.request.request.retries ?? -1;
}

console.log(retries(new RequestError("failed", { request: { retries: 3 } })));
