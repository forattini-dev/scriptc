function copy(value) { return Buffer.from(value); }
copy(new Proxy(JSON.parse('{"0":1,"length":1}'), JSON.parse('{}')));
