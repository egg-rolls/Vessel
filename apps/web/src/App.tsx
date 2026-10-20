import { AppShell } from './app/AppShell';
import { ToastProvider } from './components/ToastProvider';
import { ConnectionProvider } from './gateway/ConnectionProvider';

/**
 * 应用入口只负责组合三个全局提供者：
 * Toast（反馈）→ Connection（唯一 GatewayClient/事件缓冲）→ Shell（路由与布局）。
 * 业务状态属于各领域视图，不放在这里。
 */
export default function App() {
  return (
    <ToastProvider>
      <ConnectionProvider>
        <AppShell />
      </ConnectionProvider>
    </ToastProvider>
  );
}
