type Listener = (...args: any[]) => void;

class SimpleEmitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener) {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  emit(event: string, ...args: any[]) {
    const set = this.listeners.get(event);
    if (!set) return false;
    for (const listener of [...set]) {
      listener(...args);
    }
    return true;
  }
}

const socket = new SimpleEmitter();
const messages: Array<{ type: string; content: string; time: number }> = [];
const startTime = 1000;

socket.on("message", (msg) => {
  const content = msg.isBinary ? `<Binary ${msg.data.length} bytes>` : msg.data.toString();
  messages.push({ type: "received", content, time: 1005 - startTime });
});
socket.on("text", (data) => {
  messages.push({ type: typeof data === "string" ? "text" : "binary", content: typeof data === "string" ? data : String(data.length), time: 0 });
});
socket.on("error", (err) => {
  messages.push({ type: "error", content: err.message, time: 1010 - startTime });
});

socket.emit("message", { isBinary: false, data: "hello" });
socket.emit("message", { isBinary: true, data: [1, 2, 3] });
socket.emit("text", "plain words");
socket.emit("text", [1, 2]);
socket.emit("error", new Error("connection reset"));
console.log(socket.emit("missing"));
for (const message of messages) {
  console.log(message.type, message.content, message.time);
}
