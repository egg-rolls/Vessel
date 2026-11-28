/**
 * restart feature（q-restart-tool，R-1 事故模式）：gateway.restart 完整预约
 * （vessel op=rpc 可达；prompt 可选）。
 *
 * P2 迁移（ADR-107 第一批）：原 cli 网络面条件展开 result.gatewayRestart、
 * bootstrap 本地面手写惰性包装——R-1 正是「只接网络面、忘本地面」的事故。
 * 现单点声明，两表面共消费收集结果。
 *
 * 惰性纪律（ADR-107 决策 4）：handler 闭包读 ctx.gatewayRestart LateRef
 * （原 bootstrap 惰性包装跨 TDZ 的接口化；dispatch 发生时早已回填）。
 * 键存在性在 register 期判定（LateRef 缺省 → 不贡献键，保 cli 条件展开语义：
 * 方法仍进 manifest，handler 按 serve 既有 not_supported 语义报错）。
 */

import type { AssemblyFeature } from '../feature';

export const restartFeature: AssemblyFeature = {
  id: 'restart',
  phase: 'dispatcher',
  register(ctx) {
    const ref = ctx.gatewayRestart;
    if (ref.current === undefined) return {};
    return {
      dispatcher: {
        restart: async (input) => {
          const fn = ref.current;
          if (fn === undefined) {
            throw new Error('gateway restart surface is not available');
          }
          return fn(input);
        },
      },
    };
  },
};
