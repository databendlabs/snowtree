import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './webBridge';
import { initializeTheme } from './stores/themeStore';

const platform = (() => {
  const p = (navigator.platform || '').toLowerCase();
  if (p.includes('mac')) return 'darwin';
  if (p.includes('win')) return 'win32';
  return 'linux';
})();

document.documentElement.dataset.platform = platform;

// Initialize theme from localStorage
initializeTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
