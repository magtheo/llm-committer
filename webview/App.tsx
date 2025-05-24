// webview/App.tsx
import React, { useState } from 'react';

// Acquire VS Code API once at the module level
const vscode = (window as any).acquireVsCodeApi();

const App: React.FC = () => {
  const [count, setCount] = useState(0);

  const handleClick = () => {
    setCount(prevCount => prevCount + 1);
    // Send message to extension
    // Now 'vscode' is the stable instance acquired once
    vscode.postMessage({
      command: 'alert',
      text: `Count is now ${count + 1}` // Use current count for the message
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


export default App;