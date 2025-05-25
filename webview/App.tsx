// webview/App.tsx - Phase 4: General Context Input & Persistence
import React, { useState, useEffect, useCallback } from 'react';
import './App.css';

const vscode = (window as any).acquireVsCodeApi();

interface CurrentGroup {
    files: string[];
    specificContext: string;
    commitMessage?: string;
}

interface AppState {
    changedFiles: string[];
    currentGroup: CurrentGroup | null;
    currentView: 'fileselection' | 'group';
    selectedFiles: string[];
    generalContext: string; // Phase 4: Add general context
}

const App: React.FC = () => {
  const [count, setCount] = useState(0);
  const [appState, setAppState] = useState<AppState>({ 
    changedFiles: [], 
    currentGroup: null, 
    currentView: 'fileselection',
    selectedFiles: [],
    generalContext: '' // Phase 4: Initialize general context
  });
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);

  // Phase 4: Debounced function for general context updates
  const debounceTimeout = React.useRef<NodeJS.Timeout | null>(null);
  const debouncedUpdateGeneralContext = useCallback((context: string) => {
    if (debounceTimeout.current) {
      clearTimeout(debounceTimeout.current);
    }
    debounceTimeout.current = setTimeout(() => {
      console.log('[Webview App] Sending debounced general context update');
      vscode.postMessage({
        command: 'updateGeneralContext',
        payload: { context: context }
      });
    }, 500); // 500ms debounce
  }, []);

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

    // Cleanup timeout on unmount
    return () => {
      window.removeEventListener('message', messageListener);
      if (debounceTimeout.current) {
        clearTimeout(debounceTimeout.current);
      }
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

  // Phase 3: Grouping handlers
  const handleToggleFileSelection = (filePath: string) => {
    console.log(`[Webview App] Toggling selection for: ${filePath}`);
    vscode.postMessage({
      command: 'toggleFileSelection',
      payload: { filePath: filePath }
    });
  };

  const handleCreateGroup = () => {
    if (appState.selectedFiles.length > 0) {
      console.log('[Webview App] Creating group with selected files:', appState.selectedFiles);
      vscode.postMessage({
        command: 'createGroup',
        payload: { selectedFiles: appState.selectedFiles }
      });
    }
  };

  const handleNavigateToView = (view: 'fileselection' | 'group') => {
    console.log(`[Webview App] Navigating to view: ${view}`);
    vscode.postMessage({
      command: 'navigateToView',
      payload: { view: view }
    });
  };

  const handleUpdateGroupSpecificContext = (context: string) => {
    vscode.postMessage({
      command: 'updateGroupSpecificContext',
      payload: { context: context }
    });
  };

  const handleUpdateGroupCommitMessage = (message: string) => {
    vscode.postMessage({
      command: 'updateGroupCommitMessage',
      payload: { message: message }
    });
  };

  // Phase 4: General context handler
  const handleUpdateGeneralContext = (context: string) => {
    // Update local state immediately for responsive UI
    setAppState(prev => ({ ...prev, generalContext: context }));
    // Send debounced update to backend
    debouncedUpdateGeneralContext(context);
  };

  // Render File Selection View
  const renderFileSelectionView = () => (
    <div className="app-container">
      {/* Test section - can be removed in production */}
      <div style={{ padding: '8px 20px', borderBottom: '1px solid var(--vscode-sideBar-border)' }}>
        <button className="secondary-button" onClick={handleClick}>
          Test Alert Count: {count}
        </button>
      </div>

      {/* Phase 4: General Context Section */}
      <div className="general-context-section">
        <h2>General Context</h2>
        <div style={{ padding: '8px 12px' }}>
          <textarea
            value={appState.generalContext}
            onChange={(e) => handleUpdateGeneralContext(e.target.value)}
            placeholder="Add general context that applies to all commits (e.g., 'Working on user authentication feature', 'Bug fixes for v2.1 release')..."
            className="general-context-textarea"
            rows={3}
            style={{
              width: '100%',
              resize: 'vertical',
              boxSizing: 'border-box',
              marginBottom: '4px'
            }}
          />
          <div className="context-help-text">
            This context will be included in all commit message generations and is saved per workspace.
          </div>
        </div>
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
          
          {/* Create Group button - enabled when files are selected */}
          {appState.selectedFiles.length > 0 && (
            <button 
              className="primary-button" 
              onClick={handleCreateGroup}
              style={{ fontSize: '11px', padding: '2px 8px' }}
            >
              Create Group ({appState.selectedFiles.length})
            </button>
          )}
        </div>

        {/* Loading state */}
        {isLoadingFiles && appState.changedFiles.length === 0 && (
          <div className="loading-indicator">Loading changes...</div>
        )}

        {/* No changes message */}
        {!isLoadingFiles && appState.changedFiles.length === 0 && (
          <div className="no-changes-message">No changes detected in the current workspace.</div>
        )}

        {/* File list with selection checkboxes */}
        {appState.changedFiles.length > 0 && (
          <ul className="file-list">
            {appState.changedFiles.map((file, index) => (
              <li key={index} className={`file-item ${appState.selectedFiles.includes(file) ? 'selected' : ''}`}>
                {/* Selection checkbox */}
                <input 
                  type="checkbox"
                  checked={appState.selectedFiles.includes(file)}
                  onChange={() => handleToggleFileSelection(file)}
                  style={{ margin: '0 8px 0 12px' }}
                  aria-label={`Select ${file} for grouping`}
                />
                
                <span className="file-name" style={{ paddingLeft: '4px' }}>{file}</span>
                
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

  // Render Group View
  const renderGroupView = () => (
    <div className="app-container">
      {/* Group header with back button */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--vscode-sideBar-border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button 
          className="secondary-button" 
          onClick={() => handleNavigateToView('fileselection')}
          style={{ fontSize: '11px', padding: '2px 6px' }}
        >
          ← Back
        </button>
        <span style={{ fontSize: '13px', fontWeight: '600' }}>Create Commit Group</span>
      </div>

      {/* Group content */}
      <div className="group-content" style={{ padding: '12px' }}>
        {/* Phase 4: Show current general context in group view */}
        {appState.generalContext && (
          <div className="group-section" style={{ marginBottom: '16px' }}>
            <div style={{ 
              fontSize: '11px', 
              fontWeight: '600', 
              textTransform: 'uppercase', 
              color: 'var(--vscode-sideBarSectionHeader-foreground)',
              margin: '0 0 4px 0',
              letterSpacing: '0.05em'
            }}>
              General Context (Applied to All Commits)
            </div>
            <div style={{
              padding: '6px 8px',
              backgroundColor: 'var(--vscode-input-background)',
              border: '1px solid var(--vscode-input-border)',
              borderRadius: '2px',
              fontSize: '12px',
              color: 'var(--vscode-descriptionForeground)',
              fontStyle: 'italic'
            }}>
              "{appState.generalContext}"
            </div>
          </div>
        )}

        {/* Files in group section */}
        <div className="group-section">
          <h3 style={{ 
            fontSize: '11px', 
            fontWeight: '600', 
            textTransform: 'uppercase', 
            color: 'var(--vscode-sideBarSectionHeader-foreground)',
            margin: '0 0 8px 0',
            letterSpacing: '0.05em'
          }}>
            Files in Group ({appState.currentGroup?.files.length || 0})
          </h3>
          <ul className="file-list" style={{ marginBottom: '16px' }}>
            {appState.currentGroup?.files.map((file, index) => (
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
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Group-specific context section */}
        <div className="group-section" style={{ marginBottom: '16px' }}>
          <label htmlFor="group-context" style={{ 
            display: 'block', 
            fontSize: '11px', 
            fontWeight: '600', 
            textTransform: 'uppercase',
            color: 'var(--vscode-sideBarSectionHeader-foreground)',
            margin: '0 0 8px 0',
            letterSpacing: '0.05em'
          }}>
            Group Specific Context
          </label>
          <textarea
            id="group-context"
            value={appState.currentGroup?.specificContext || ''}
            onChange={(e) => handleUpdateGroupSpecificContext(e.target.value)}
            placeholder="Add context specific to this group of changes..."
            style={{
              width: '100%',
              minHeight: '60px',
              resize: 'vertical',
              boxSizing: 'border-box'
            }}
          />
          <div className="context-help-text">
            This context applies only to this specific group of files.
          </div>
        </div>

        {/* Generated commit message section */}
        <div className="group-section">
          <label htmlFor="commit-message" style={{ 
            display: 'block', 
            fontSize: '11px', 
            fontWeight: '600', 
            textTransform: 'uppercase',
            color: 'var(--vscode-sideBarSectionHeader-foreground)',
            margin: '0 0 8px 0',
            letterSpacing: '0.05em'
          }}>
            Commit Message
          </label>
          <textarea
            id="commit-message"
            value={appState.currentGroup?.commitMessage || ''}
            onChange={(e) => handleUpdateGroupCommitMessage(e.target.value)}
            placeholder="Commit message will be generated here or you can write one manually..."
            style={{
              width: '100%',
              minHeight: '80px',
              resize: 'vertical',
              boxSizing: 'border-box',
              marginBottom: '12px'
            }}
          />
          
          {/* Action buttons */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button className="primary-button" style={{ fontSize: '13px' }}>
              Generate Message
            </button>
            <button 
              className="secondary-button" 
              disabled={!appState.currentGroup?.commitMessage?.trim()}
              style={{ fontSize: '13px' }}
            >
              Stage Group
            </button>
          </div>
          
          {/* Help text explaining the generation process */}
          <div className="context-help-text" style={{ marginTop: '8px' }}>
            Generate Message will use the general context, group-specific context, and file diffs to create a commit message.
          </div>
        </div>
      </div>
    </div>
  );

  // Main render - switch views based on current view
  return (
    <>
      {appState.currentView === 'fileselection' && renderFileSelectionView()}
      {appState.currentView === 'group' && renderGroupView()}
    </>
  );
};

export default App;