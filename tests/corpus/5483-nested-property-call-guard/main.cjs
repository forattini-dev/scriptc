class Timer {
  refresh() {
    console.log('refreshed')
  }
}

class Parser {
  constructor() {
    this.timeout = process.argv.length > 100 ? 0 : new Timer()
  }

  resume() {
    if (this.timeout) {
      if (this.timeout.refresh) {
        this.timeout.refresh()
      }
    }
  }
}

const parser = new Parser()
parser.resume()
