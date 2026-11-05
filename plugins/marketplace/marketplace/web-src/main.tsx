import { applyHostContext, readHostContext } from '@vessel-agent/plugin-ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Apply theme/lang before the first paint so the iframe never flashes light.
applyHostContext(readHostContext());

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
