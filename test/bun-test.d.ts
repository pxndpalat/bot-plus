declare module "bun:test" {
  export type TestCallback = () => void | Promise<void>;
  export interface TestFunction {
    (name: string, callback: TestCallback): void;
    skip(name: string, callback: TestCallback): void;
  }
  export const test: TestFunction;
}
