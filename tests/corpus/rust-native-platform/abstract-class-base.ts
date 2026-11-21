abstract class Shape {
  abstract kind: string;
  abstract detail: string;
  abstract area(): number;
  readonly label = "shape";

  constructor(public name: string) {}

  describe() {
    return `${this.label}:${this.kind}:${this.detail}:${this.area()}`;
  }
}

class Square extends Shape {
  kind = "square";

  get detail() {
    return `${this.side}x${this.side}`;
  }

  constructor(public side: number) {
    super("unit");
  }

  area() {
    return this.side * this.side;
  }
}

const shape: Shape = new Square(3);
console.log(shape instanceof Shape, shape instanceof Square, shape.name, shape.describe());
