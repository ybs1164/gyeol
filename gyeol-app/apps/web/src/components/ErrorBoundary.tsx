import { Component, type ReactNode } from 'react';
import { t } from '../i18n';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="screen home">
        <div className="panel">
          <h3>{t('err.title')}</h3>
          <p className="text muted">{this.state.error.message}</p>
          <button
            className="btn primary"
            onClick={() => {
              location.hash = '';
              location.reload();
            }}
          >
            {t('btn.home')}
          </button>
        </div>
      </div>
    );
  }
}
