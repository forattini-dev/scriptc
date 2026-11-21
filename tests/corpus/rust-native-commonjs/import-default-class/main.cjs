var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };

const Base_1 = __importDefault(require("./base.cjs"));

class Child extends Base_1.default {
  constructor(value) {
    super(value);
  }
}

const child = new Child(7);
console.log(child instanceof Child, child instanceof Base_1.default, child.read());
