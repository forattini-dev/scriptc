// Deferred Date fields must still refuse until reads before initialization
// can preserve undefined rather than manufacture a Date object.

class DeferredDate {
  value!: Date;
  initialize(): void {
    this.value = new Date(0);
  }
}
const deferred = new DeferredDate();
deferred.initialize();
// Initialization after construction remains outside the supported field contract.
