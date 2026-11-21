type SocketLike = {
  url: string;
  send: (data: string) => number;
};

type SocketConstructor = new (url: string, protocols?: string | string[]) => SocketLike;

const registry: any = {
  Socket: class {
    url: string;
    protocols: string[];
    constructor(url: string, protocols?: string | string[]) {
      this.url = url;
      this.protocols = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
    }
    send(data: string): number {
      return data.length + this.protocols.length;
    }
  },
};

async function getSocketConstructor(): Promise<SocketConstructor> {
  return registry.Socket as SocketConstructor;
}

async function main(): Promise<void> {
  const Ctor = await getSocketConstructor();
  const plain = new Ctor("ws://a");
  const chat = new Ctor("ws://b", ["chat", "json"]);
  console.log(plain.url, plain.send("hi"));
  console.log(chat.url, chat.send("hello"));
  const missing = (registry as any).Missing as SocketConstructor | undefined;
  try {
    if (!missing) throw new TypeError("no constructor");
    new missing("ws://c");
  } catch (error) {
    console.log((error as Error).message);
  }
}

main();
