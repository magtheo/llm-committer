import React, { useState } from 'react';

const App: React.FC = () => {
  const [count, setCount] = useState(0);
  
  // Acquire VS Code API
  const vscode = acquireVsCodeApi();
  
  const handleClick = () => {
    setCount(prevCount => prevCount + 1);
    // Send message to extension
    vscode.postMessage({
      command: 'alert',
      text: `Count is now ${count + 1}`
    });
  };

  return (
    <div>
      <h1>VS Code Extension Webview</h1>
      <button onClick={handleClick}>
        Count: {count}
      </button>
    </div>
  );
};

// Helper function to get the VS Code API
function acquireVsCodeApi() {
  return (window as any).acquireVsCodeApi();
}

export default App;