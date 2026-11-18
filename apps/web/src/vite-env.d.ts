/// <reference types="vite/client" />

/**
 * plugin-embed 契约 §6：宿主在 createRoot 前注册的共享模块表（main.tsx）。
 * vendor shim 从这里取同一份 React / SDK 实例；未注册时 shim throw。
 */
interface VesselSharedModules {
  React: typeof import('react');
  ReactDOM: typeof import('react-dom');
  ReactDOMClient: typeof import('react-dom/client');
  JsxRuntime: typeof import('react/jsx-runtime');
  PluginSdk: typeof import('@vessel-agent/plugin-sdk');
}

declare global {
  var __VESSEL_SHARED__: VesselSharedModules | undefined;
  /** vite define 注入（真源：packages/plugin-sdk/package.json 的 version）。 */
  const __VESSEL_PLUGIN_SDK_VERSION__: string;
}

export {};
