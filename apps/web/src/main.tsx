import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { applyTheme, readStoredTheme } from './state/theme';

// 主题必须在首帧前应用：刷新后不应先闪一下系统主题再切到用户选择。
applyTheme(readStoredTheme(localStorage));

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(<App />);
