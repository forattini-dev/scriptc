class PingEvent extends Event {
  constructor() {
    super("ping", { cancelable: true });
  }
}

const event = new PingEvent();
console.log(event instanceof PingEvent, event instanceof Event);
