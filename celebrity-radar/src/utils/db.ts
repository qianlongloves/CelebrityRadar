import { cloud } from './cloud'

/**
 * 统一表访问入口。
 * SDK 的 Database 泛型默认 unknown，from() 会退化为 never[]；
 * 此处集中做一次断言，行类型集中在 types/db.ts（阶段 4 收口，替代散落的局部断言）。
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export function table(name: string): any {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  return (cloud.database.from as (t: string) => any)(name)
}
