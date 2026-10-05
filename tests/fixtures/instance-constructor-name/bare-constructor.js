class Base { read() { console.log(this.constructor === Base); } }
new Base().read();
