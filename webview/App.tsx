// webview/App.tsx
import React, { useState, useEffect } from 'react';

const vscode = (window as any).acquireVsCodeApi();

interface AppState {
    changedFiles: string[];
}

const App: React.FC = () => {
  const [count, setCount] = useState(0);
  const [appState, setAppState] = useState<AppState>({ changedFiles: [] });

  useEffect(() => {
    // Listener for messages from the extension
    const messageListener = (event: MessageEvent) => {
      const message = event.data; // The data VS Code sent
      switch (message.command) {
        case 'stateUpdate':
          console.log('[Webview App] Received stateUpdate:', message.payload);
          setAppState(message.payload);
          break;
      }
    };
    window.addEventListener('message', messageListener);

    // Signal extension that webview is ready
    vscode.postMessage({ command: 'uiReady' });
    // Or, specifically request changes:
    // vscode.postMessage({ command: 'fetchChanges' });

    // Cleanup listener
    return () => {
      window.removeEventListener('message', messageListener);
    };
  }, []); // Empty dependency array means this effect runs once on mount

  const handleClick = () => {
    setCount(prevCount => prevCount + 1);
    vscode.postMessage({
      command: 'alert',
      text: `Count is now ${count + 1}`
    });
  };

  const handleRefreshChanges = () => {
    vscode.postMessage({ command: 'fetchChanges' });
  };

  return (
    <div>
      <h1>LLM Committer</h1>
      <button onClick={handleClick}>
        Count: {count}
      </button>
      <hr />
      <h2>Changed Files:</h2>
      <button onClick={handleRefreshChanges}>Refresh Files</button>
      {appState.changedFiles.length === 0 ? (
        <p>No changes detected or yet to load.</p>
      ) : (
        <ul>
          {appState.changedFiles.map((file, index) => (
            <li key={index}>{file}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default App;