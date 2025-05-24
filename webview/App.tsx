// webview/App.tsx
import React, { useState, useEffect } from 'react';
import './App.css'; // Optional: Create an App.css for basic styling

// Acquire VS Code API once at the module level
const vscode = (window as any).acquireVsCodeApi();

interface AppState {
    changedFiles: string[];
    // you can add other state parts here later, like generalContext, etc.
}

const App: React.FC = () => {
  const [count, setCount] = useState(0); // Example state, can be removed if not needed
  const [appState, setAppState] = useState<AppState>({ changedFiles: [] });
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);

  useEffect(() => {
    const messageListener = (event: MessageEvent) => {
      const message = event.data;
      switch (message.command) {
        case 'stateUpdate':
          console.log('[Webview App] Received stateUpdate:', message.payload);
          setAppState(message.payload);
          setIsLoadingFiles(false); // Assume loading finishes when state updates
          break;
      }
    };
    window.addEventListener('message', messageListener);

    // Signal extension that webview is ready and request initial data
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
    // No need to setIsLoadingFiles(true) here, as the list will refresh after revert
    vscode.postMessage({
      command: 'revertFileChanges',
      payload: { filePath: filePath }
    });
  };

  return (
    <div className="app-container">
      <h1>LLM Committer</h1>
      <p>
        <button onClick={handleClick}>Test Alert Count: {count}</button>
      </p>
      <hr />
      <div className="changes-section">
        <h2>Changed Files:</h2>
        <button onClick={handleRefreshChanges} disabled={isLoadingFiles}>
          {isLoadingFiles ? 'Loading...' : 'Refresh Files'}
        </button>
        {isLoadingFiles && appState.changedFiles.length === 0 && <p>Loading changes...</p>}
        {!isLoadingFiles && appState.changedFiles.length === 0 && (
          <p>No changes detected in the current workspace.</p>
        )}
        {appState.changedFiles.length > 0 && (
          <ul className="file-list">
            {appState.changedFiles.map((file, index) => (
              <li key={index} className="file-item">
                <span className="file-name">{file}</span>
                <div className="file-actions">
                  <button onClick={() => handleViewDiff(file)} title="View Diff">
                    Diff
                  </button>
                  <button onClick={() => handleRevertFile(file)} title="Revert Changes" className="revert-button">
                    Revert
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