// @ts-nocheck
class PageIterator {
  async next() {
    return { done: false, value: 4 };
  }
}

function gather(iterator) {
  return iterator.next().then((result) => result.value + 1);
}

gather(new PageIterator());
console.log("scheduled");
