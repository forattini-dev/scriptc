// @ts-nocheck
class States {
  constructor(status1) {
    this.status = status1;
    this.counts = this.status.map(function () {
      return 0;
    });
  }

  statusJobs(status) {
    const pos = this.status.indexOf(status);
    if (pos < 0) {
      throw new Error(`status must be one of ${this.status.join(", ")}`);
    }
    return pos;
  }
}

const trackDoneStatus = true;
const states = new States(
  ["RECEIVED", "QUEUED", "RUNNING", "EXECUTING"].concat(
    trackDoneStatus ? ["DONE"] : [],
  ),
);
console.log(`${states.statusJobs("DONE")}|${states.counts.join(",")}`);
