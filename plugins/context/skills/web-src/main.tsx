import { applyHostContext, readHostContext } from '@vessel-agent/plugin-ui';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Apply theme/lang before the first paint so the iframe never flashes light.
applyHostContext(readHostContext());

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Skills plugin UI is missing the #root mount point.');
}

createRoot(rootElement).render(<App />);
