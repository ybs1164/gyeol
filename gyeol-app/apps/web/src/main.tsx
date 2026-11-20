import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, applySettings } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { isNative } from './lib/platform';
import { setupNative } from './lib/native';
import { setupLayout } from './lib/layout';
import './styles.css';

setupLayout();
applySettings();
void setupNative();

// 앱(안드로이드)에서는 파일이 기기 안에 있으므로 서비스 워커가 필요 없다
if (!isNative() && 'serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
