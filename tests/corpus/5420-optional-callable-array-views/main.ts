interface RequestView {
  url: string
}

type BeforeRequest = (
  request: RequestView
) => RequestView | void | Promise<RequestView | void>

type AfterResponse = (
  request: RequestView,
  response: { status: number }
) => { status: number } | void

class Client {
  private hooks: {
    beforeRequest?: BeforeRequest[]
    afterResponse?: AfterResponse[]
  } = {}

  beforeRequest(hook: BeforeRequest) {
    if (!this.hooks.beforeRequest) {
      this.hooks.beforeRequest = []
    }
    this.hooks.beforeRequest.push(hook)
  }

  count() {
    return (this.hooks.beforeRequest?.length ?? 0) +
      (this.hooks.afterResponse?.length ?? 0)
  }

  afterResponse(hook: AfterResponse) {
    if (!this.hooks.afterResponse) {
      this.hooks.afterResponse = []
    }
    this.hooks.afterResponse.push(hook)
  }
}

const client = new Client()
client.beforeRequest((request) => ({ url: `${request.url}/checked` }))
client.afterResponse((_request, response) => ({ status: response.status + 1 }))
console.log(client.count())
