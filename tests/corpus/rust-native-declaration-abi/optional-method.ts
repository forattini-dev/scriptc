interface TextLike<T> {
  text(limit?: T): string;
}

const value: TextLike<number> = {
  text(limit = 7): string {
    return `limit:${limit}`;
  },
};

console.log("optional method", value.text(), value.text(3));
