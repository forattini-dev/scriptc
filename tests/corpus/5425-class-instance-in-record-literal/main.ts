interface RequestView {
  url: string
}

class HttpRequest implements RequestView {
  constructor(public url: string) {}
}

function emit(event: { req: RequestView }, original: HttpRequest) {
  event.req.url = `${event.req.url}seen`
  console.log(original.url)
}

const req = new HttpRequest('https://example.test/')
emit({ req }, req)
