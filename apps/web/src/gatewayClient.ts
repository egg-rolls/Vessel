/**
 * Browser gateway client —— 连接 Vessel gateway（`@vessel/serve`）。
 *
 * gateway 协议（见 packages/serve/src/gateway.ts）：
 *   - WS    `/ws?token=`     newline-delimited RunEvent JSON，连接时服务端先回放历史
 *   - REST  `GET /sessions`  → { sessions: SessionInfo[] }
 *   - REST  `POST /run` body { input, session_id? } → { output }
 *   鉴权：`?token=` 或 `Authorization: Bearer <token>`（浏览器 WS 无法带 header，故 WS 用 ?token=）
 */

import type { RunEvent, SessionInfo } from './types';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

export class GatewayClient {
  private readonly baseUrl: string;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  private eventListeners = new Set<(e: RunEvent) => void>();
  private stateListeners = new Set<(s: ConnectionState) => void>();

  constructor(baseUrl = 'http://localhost:8642') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    for (const cb of [...this.stateListeners]) cb(next);
  }

  /** 订阅连接状态变化，返回取消订阅函数 */
  onState(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    cb(this.state);
    return () => this.stateListeners.delete(cb);
  }

  /** 订阅 RunEvent，返回取消订阅函数 */
  onEvent(cb: (e: RunEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  private wsUrl(): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/ws`;
  }

  connect(token: string): Promise<void> {
    const tk = token.trim();
    if (!tk) return Promise.reject(new Error('token 不能为空'));
    if (this.state === 'open' || this.state === 'connecting') return Promise.resolve();

    this.setState('connecting');
    const ws = new WebSocket(`${this.wsUrl()}?token=${encodeURIComponent(tk)}`);
    this.ws = ws;

    // 服务端按 newline 逐条推送 JSON，单帧可能包含多条
    ws.addEventListener('message', (ev) => {
      const frames = String(ev.data)
        .split('\n')
        .filter((f) => f.trim());
      for (const frame of frames) {
        try {
          const event = JSON.parse(frame) as RunEvent;
          for (const cb of [...this.eventListeners]) cb(event);
        } catch {
          // 忽略非法帧
        }
      }
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return; // 忽略过期 socket 的关闭
      this.ws = null;
      this.setState('closed');
    });

    return new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener('error', onError);
        this.setState('open');
        resolve();
      };
      const onError = () => {
        ws.removeEventListener('open', onOpen);
        this.setState('error');
        reject(new Error(`WebSocket 连接失败（gateway 未启动或 token 无效）：${this.wsUrl()}`));
      };
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
    });
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setState('closed');
  }

  private async request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      });
    } catch {
      // 网络层失败（连接被拒 / DNS / CORS）——通常是 gateway 未启动
      throw new Error(`无法连接 gateway（${this.baseUrl}）——请确认 gateway 已启动且地址正确`);
    }

    if (res.status === 401) {
      throw new Error('鉴权失败（401）——token 错误或已失效');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${path} ${res.status}：${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async fetchSessions(token: string): Promise<SessionInfo[]> {
    const body = await this.request<{ sessions?: SessionInfo[] }>('/sessions', token);
    return body.sessions ?? [];
  }

  async run(token: string, input: string, sessionId?: string): Promise<string> {
    const body = await this.request<{ output?: string }>('/run', token, {
      method: 'POST',
      body: JSON.stringify({ input, ...(sessionId ? { session_id: sessionId } : {}) }),
    });
    return body.output ?? '';
  }
}
