class DNSInstance {
  lookup = null

  constructor(options) {
    this.lookup = options.lookup ?? this.#defaultLookup
  }

  #defaultLookup(origin, options, callback) {
    callback(null, [{ address: origin, family: options.family }])
  }

  run(origin) {
    this.lookup(origin, { family: 4 }, (error, addresses) => {
      console.log(error === null, addresses[0].address, addresses[0].family)
    })
  }
}

new DNSInstance({}).run('host.test')
