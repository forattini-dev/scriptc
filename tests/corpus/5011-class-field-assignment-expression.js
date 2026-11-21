class Holder {
  reset() {
    return this.value = "ready";
  }
}

const holder = new Holder();
console.log(holder.reset());
console.log(holder.value);
