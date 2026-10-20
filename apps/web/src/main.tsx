import { createRoot } from 'react-dom/client';
import App from './App';
import { getLocale } from './i18n';
import './index.css';
import { applyTheme, readStoredTheme } from './state/theme';

// 主题必须在首帧前应用：刷新后不应先闪一下系统主题再切到用户选择。
applyTheme(readStoredTheme(localStorage));
// 首帧前同步语言标记（locale 本身已由 i18n 初始化）。
document.documentElement.lang = getLocale();

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(<App />);
