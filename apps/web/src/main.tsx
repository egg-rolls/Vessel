import * as PluginSdk from '@vessel-agent/plugin-sdk';
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import App from './App';
import { getLocale } from './i18n';
import './index.css';
import { applyDepthColorTokens } from './state/depth-color';
import { applyTheme, readStoredTheme } from './state/theme';
import { resourceData } from './state/useResource';
import { useConfigStore } from './stores/configStore';

// plugin-embed 契约 §6：React 单例注册必须在 createRoot 之前 —— vendor shim
// （/assets/vendor/*.mjs）只做静态具名导出，全部取自这里注册的同一份模块实例。
globalThis.__VESSEL_SHARED__ = { React, ReactDOM, ReactDOMClient, JsxRuntime, PluginSdk };

// 主题必须在首帧前应用：刷新后不应先闪一下系统主题再切到用户选择。
applyTheme(readStoredTheme(localStorage));
// 首帧前同步语言标记（locale 本身已由 i18n 初始化）。
document.documentElement.lang = getLocale();

// depth-color：L/C 四变量的**唯一写者**（0.52「DOM 主题唯一写者」同款 invariant，
// theme.ts 先例）。订阅 configStore：首帧（config.get 回报）+ 配置保存确认后的每次
// 快照变化都重应用；未配置时 normalize 写缺省锚点（与 tokens.css CSS 缺省等价）。
// 只写 --depth-l/-c 四变量，不写 data-theme、不碰主题。
let lastDepthConfig = useConfigStore.getState().config;
applyDepthColorTokens(resourceData(lastDepthConfig));
useConfigStore.subscribe((state) => {
  if (state.config === lastDepthConfig) return;
  lastDepthConfig = state.config;
  applyDepthColorTokens(resourceData(state.config));
});

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

ReactDOMClient.createRoot(container).render(<App />);
