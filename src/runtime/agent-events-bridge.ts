/**
 * agent 事件晚绑定桥（q-sub-unify-p1 M6）。
 *
 * 插件 install 早于 AgentService wiring：好友边 listener 在 install 时注册到本桥，
 * wiring 完成后装配调 bindAgentEventsService 把真实 service 接上（pending listener
 * 即刻 fan-out）。sessionOf 取成员**当前 primary body** 的 session
 *（service.list 的 session_id 即 primary binding，lead 裁定 M6 语义；
 * 注意 peerParentSessionOf 是「父」session 口，不适用）。
 *
 * 不新增事件种类：只转发 AgentService.subscribe 的现态事件流。
 *
 * @module vessel/agent-events-bridge
 */

import type { AgentService } from '../../packages/agent/src/index';
import type { FriendSpawnEvent } from '../../plugins/context/doc-subscription/src/index';

type Listener = (event: FriendSpawnEvent) => void;

const listeners = new Set<Listener>();
let service: AgentService | undefined;
let unsubscribe: (() => void) | undefined;

/** wiring 完成后绑定真实 service（重复绑定先断旧链）。 */
export function bindAgentEventsService(next: AgentService): void {
  unsubscribe?.();
  service = next;
  unsubscribe = next.subscribe((event) => {
    for (const listener of [...listeners]) {
      try {
        listener(event as unknown as FriendSpawnEvent);
      } catch {
        // 单 listener 失败不打断其它（现态 emitForSession 隔离先例）。
      }
    }
  });
}

/** 进程收口断链（shutdown-sequence 调用）。 */
export function unbindAgentEventsService(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  service = undefined;
}

/**
 * 注入插件 install 的端口（plugin-config 写进 doc-subscription 安装配置）。
 * subscribe 先于绑定也有效（listener 入集合，绑定时 fan-out）。
 */
export const agentEventsPort = {
  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  async sessionOf(memberId: string): Promise<string | undefined> {
    if (service === undefined) return undefined;
    const members = await service.list();
    return members.find((member) => member.id === memberId)?.session_id;
  },
};
