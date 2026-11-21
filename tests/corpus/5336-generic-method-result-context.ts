// @rust-only
// @no-engine
export {};

class Client {
  request<T>(path: string): T {
    return path as T;
  }

  get<T>(path: string) {
    return this.request<T>(path);
  }
}

const value: string = new Client().get<string>("generic-ok");
console.log(value);
const erased = new Client().get("default-ok");
console.log(erased);
