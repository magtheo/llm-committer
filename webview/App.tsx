// webview/App.tsx - Updated with VS Code SCM styling
import React, { useState, useEffect } from 'react';
import './App.css';

const vscode = (window as any).acquireVsCodeApi();

interface AppState {
    changedFiles: string[];
}

const App: React.FC = () => {
  const [count, setCount] = useState(0);
  const [appState, setAppState] = useState<AppState>({ changedFiles: [] });
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);

  useEffect(() => {
    const messageListener = (event: MessageEvent) => {
      const message = event.data;
      switch (message.command) {
        case 'stateUpdate':
          console.log('[Webview App] Received stateUpdate:', message.payload);
          setAppState(message.payload);
          setIsLoadingFiles(false);
          break;
      }
    };
    window.addEventListener('message', messageListener);

    setIsLoadingFiles(true);
    vscode.postMessage({ command: 'uiReady' });

    return () => {
      window.removeEventListener('message', messageListener);
    };
  }, []);

  const handleClick = () => {
    setCount(prevCount => prevCount + 1);
    vscode.postMessage({
      command: 'alert',
      text: `Count is now ${count + 1}`
    });
  };

  const handleRefreshChanges = () => {
    console.log('[Webview App] Requesting fetchChanges');
    setIsLoadingFiles(true);
    vscode.postMessage({ command: 'fetchChanges' });
  };

  const handleViewDiff = (filePath: string) => {
    console.log(`[Webview App] Requesting viewFileDiff for: ${filePath}`);
    vscode.postMessage({
      command: 'viewFileDiff',
      payload: { filePath: filePath }
    });
  };

  const handleRevertFile = (filePath: string) => {
    console.log(`[Webview App] Requesting revertFileChanges for: ${filePath}`);
    vscode.postMessage({
      command: 'revertFileChanges',
      payload: { filePath: filePath }
    });
  };

  return (
    <div className="app-container">
      {/* Test section - can be removed in production */}
      <div style={{ padding: '8px 20px', borderBottom: '1px solid var(--vscode-sideBar-border)' }}>
        <button className="secondary-button" onClick={handleClick}>
          Test Alert Count: {count}
        </button>
      </div>

      {/* Main changes section matching SCM layout */}
      <div className="changes-section">
        {/* Section header matching SCM style */}
        <h2>Changes</h2>
        
        {/* Toolbar area matching SCM */}
        <div style={{ padding: '4px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button 
            className="secondary-button" 
            onClick={handleRefreshChanges} 
            disabled={isLoadingFiles}
            style={{ fontSize: '11px', padding: '2px 6px' }}
          >
            {isLoadingFiles ? '⟳' : '↻'} Refresh
          </button>
        </div>

        {/* Loading state */}
        {isLoadingFiles && appState.changedFiles.length === 0 && (
          <div className="loading-indicator">Loading changes...</div>
        )}

        {/* No changes message */}
        {!isLoadingFiles && appState.changedFiles.length === 0 && (
          <div className="no-changes-message">No changes detected in the current workspace.</div>
        )}

        {/* File list matching SCM exactly */}
        {appState.changedFiles.length > 0 && (
          <ul className="file-list">
            {appState.changedFiles.map((file, index) => (
              <li key={index} className="file-item">
                <span className="file-name">{file}</span>
                <div className="file-actions">
                  <button 
                    onClick={() => handleViewDiff(file)} 
                    title="Open Changes"
                    aria-label={`Open changes for ${file}`}
                  >
                    ⎕
                  </button>
                  <button 
                    onClick={() => handleRevertFile(file)} 
                    title="Discard Changes"
                    className="revert-button"
                    aria-label={`Discard changes for ${file}`}
                  >
                    ↶
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default App;