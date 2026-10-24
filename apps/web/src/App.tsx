import { AppShell } from './app/AppShell';
import { ToastProvider } from './components/ToastProvider';
import { ConnectionProvider } from './gateway/ConnectionProvider';
import { NodeProvider } from './gateway/NodeProvider';

/**
 * 应用入口只负责组合全局提供者：
 * Toast（反馈）→ Connection（唯一 GatewayClient/事件缓冲）
 * → Node（当前连接 + sessionStorage 额外节点）→ Shell（路由与布局）。
 * 业务状态属于各领域视图，不放在这里。
 */
export default function App() {
  return (
    <ToastProvider>
      <ConnectionProvider>
        <NodeProvider>
          <AppShell />
        </NodeProvider>
      </ConnectionProvider>
    </ToastProvider>
  );
}
