type Reason = "done" | "failed";

interface Result {
  reason: Reason | undefined;
}

interface Handle {
  stop(reason?: Reason): Result;
}

function make(): Handle {
  let calls = 0;
  function stop(reason: Reason): Result {
    calls += 1;
    return { reason };
  }
  const original = stop;
  const handle = { stop };
  console.log(handle.stop === original);
  return handle;
}

const handle = make();
console.log(
  handle.stop("done").reason,
  handle.stop().reason,
  handle.stop === handle.stop,
);
