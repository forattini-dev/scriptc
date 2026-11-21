async function framed<TRequest, TResponse>(request: TRequest): Promise<TResponse> {
  return request as unknown as TResponse;
}

async function line<TRequest, TResponse>(request: TRequest): Promise<TResponse> {
  const response = await framed<TRequest, TResponse>(request);
  return response;
}

line<number, number>(42).then((value) => console.log(value));
