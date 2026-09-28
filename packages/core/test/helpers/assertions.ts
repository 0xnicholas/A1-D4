/**
 * 测试共享断言工具:编译期断言与错误捕获。各测试文件从同一份实现取用,不各自复制。
 */

/**
 * 编译期断言:`expectAssignable<To>(value)` 要求 value 的类型可赋值给 `To`,不满足时 tsc 直接报
 * "not assignable"。不用 expect-type 的 `toExtend`:它在 `exactOptionalPropertyTypes` 下对含联合与
 * 可选属性的对象给出假阴性(普通赋值可通过)。函数体运行时为空。
 */
export function expectAssignable<To>(_value: To): void {}

/** 捕获 `run()` 抛出的 Error;未抛出、或抛出的不是 Error 时失败。 */
export function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected the call to throw an Error');
}
