/**
 * 测试共享工具:把异步可迭代对象收敛为数组。多个测试文件从同一份实现取用,不各自复制
 * (规则见 `helpers/assertions.ts`)。
 */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
