import { AppShell } from './app/AppShell';
import { AuthProvider } from './auth/AuthProvider';
import { ToastProvider } from './components/ToastProvider';
import { ComposerExtensionsProvider } from './domains/plugins/composer-extensions';
import { ConnectionProvider } from './gateway/ConnectionProvider';
import { NodeProvider } from './gateway/NodeProvider';

/**
 * 应用入口只负责组合全局提供者：
 * Toast（反馈）→ Auth（0.56 WebUI 登录闸：未登录时只给登录页，不发起任何 RPC）
 * → Connection（平台引导 + 唯一 node 客户端/事件缓冲）
 * → Node（当前连接 + sessionStorage 额外节点）
 * → ComposerExtensions（插件 composer 内嵌贡献：原子卡片 / drop / link 增强器）
 * → Shell（路由与布局）。
 * 业务状态属于各领域视图，不放在这里。
 */
export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <ConnectionProvider>
          <NodeProvider>
            <ComposerExtensionsProvider>
              <AppShell />
            </ComposerExtensionsProvider>
          </NodeProvider>
        </ConnectionProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
