/**
 * jobs feature（q-async-bash-viz）：异步 bash 作业只读观察面（jobs.*）。
 *
 * P2 迁移（ADR-107 第一批，事故模式 feature 之一）：原仅 cli 网络面手写 jobs
 * deps，bootstrap 本地面缺省 → vessel op=rpc jobs.* not_supported（R-1/R-6
 * 同款「忘接一路」）。收集器使两表面共消费同一份——本地面 additive 获得
 * jobs.list / jobs.log（ADR-107 预期修复，非回归）。
 *
 * 注册表唯一真相源是 basic-tools 的进程级作业表（会话绑定经 sessionId 过滤）；
 * serve 只出形状。两函数是进程级纯读口（无活值定格问题，ADR-107 决策 4 天然满足）。
 */

import {
  listAsyncBashJobs,
  readAsyncBashJobLogTail,
} from '../../../plugins/tools/basic-tools/src/index';
import type { AssemblyFeature } from '../feature';

export const jobsFeature: AssemblyFeature = {
  id: 'jobs',
  phase: 'dispatcher',
  register() {
    return {
      dispatcher: {
        jobs: {
          list: (sessionId) => listAsyncBashJobs(sessionId),
          logTail: (jobId, maxBytes) => readAsyncBashJobLogTail(jobId, maxBytes),
        },
      },
    };
  },
};
