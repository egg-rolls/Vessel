import { applyHostContext, readHostContext } from '@vessel-agent/plugin-ui';
import { createRoot } from 'react-dom/client';
import { App, type PluginView } from './App';
import './styles.css';

// Apply theme/lang before the first paint so the iframe never flashes light.
applyHostContext(readHostContext());

const VIEWS: readonly PluginView[] = ['usage', 'logs'];

function currentView(): PluginView {
  const value = document.body.dataset.view;
  return VIEWS.includes(value as PluginView) ? (value as PluginView) : 'usage';
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Usage plugin UI is missing the #root mount point.');

createRoot(rootElement).render(<App view={currentView()} />);
