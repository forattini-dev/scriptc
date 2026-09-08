// Original source callback-this witness, isolated from unrelated Fetch APIs.
let startThis = "not-called";
let pullThis = "not-called";
let cancelThis = "not-called";

function start(controller) {
  startThis = this && this.marker;
  controller.enqueue("chunk");
}

function pull(controller) {
  pullThis = this && this.marker;
  controller.close();
}

function cancel() {
  cancelThis = this && this.marker;
}

const source = { marker: "source", start, pull };
const reader = new ReadableStream(source).getReader();
const first = await reader.read();
const done = await reader.read();

const cancelSource = { marker: "cancel-source", cancel };
const cancelStream = new ReadableStream(cancelSource);
await cancelStream.cancel();

function mutatingStart() {
  this.marker = "changed";
}

const mutatingSource = { marker: "original", start: mutatingStart };
new ReadableStream(mutatingSource);

console.log(
  "stream source callback this:",
  startThis,
  pullThis,
  cancelThis,
  first.value,
  done.done,
);
console.log("stream source callback mutation:", mutatingSource.marker);

export {};
