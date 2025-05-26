// webview/App.tsx - Phase 5+6: Complete LLM Integration with Claude Support
import React, { useState, useEffect, useCallback } from 'react';
import './App.css';

const vscode = (window as any).acquireVsCodeApi();

interface CurrentGroup {
    files: string[];
    specificContext: string;
    commitMessage?: string;
    isGenerating?: boolean;
}

interface AppState {
    changedFiles: string[];
    currentGroup: CurrentGroup | null;
    currentView: 'fileselection' | 'group' | 'settings';
    selectedFiles: string[];
    generalContext: string;
    settings: {
        hasApiKey: boolean;
        provider: 'openai' | 'anthropic';
        model: string;
        maxTokens: number;
        temperature: number;
        instructionsLength: number;
    };
}

const App: React.FC = () => {
  const [count, setCount] = useState(0);
  const [appState, setAppState] = useState<AppState>({ 
    changedFiles: [], 
    currentGroup: null, 
    currentView: 'fileselection',
    selectedFiles: [],
    generalContext: '',
    settings: {
        hasApiKey: false,
        provider: 'openai',
        model: 'gpt-4o-mini',
        maxTokens: 4000,
        temperature: 0.3,
        instructionsLength: 0
    }
  });
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);

  // Phase 5+6: Settings form state
  const [settingsForm, setSettingsForm] = useState({
    apiKey: '',
    instructions: '',
    provider: 'openai' as 'openai' | 'anthropic',
    model: 'gpt-4o-mini',
    maxTokens: 4000,
    temperature: 0.3
  });

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
    }, 500);
  }, []);

  useEffect(() => {
    const messageListener = (event: MessageEvent) => {
      const message = event.data;
      switch (message.command) {
        case 'stateUpdate':
          console.log('[Webview App] Received stateUpdate:', message.payload);
          setAppState(message.payload);
          setIsLoadingFiles(false);
          
          // Update settings form when switching to settings view OR when settings change
          if (message.payload.currentView === 'settings' || message.payload.settings) {
            setSettingsForm(prev => ({
              ...prev,
              provider: message.payload.settings.provider || 'openai',
              model: message.payload.settings.model,
              maxTokens: message.payload.settings.maxTokens,
              temperature: message.payload.settings.temperature
            }));
          }
          break;
      }
    };
    window.addEventListener('message', messageListener);

    setIsLoadingFiles(true);
    vscode.postMessage({ command: 'uiReady' });

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

  const handleNavigateToView = (view: 'fileselection' | 'group' | 'settings') => {
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
    setAppState(prev => ({ ...prev, generalContext: context }));
    debouncedUpdateGeneralContext(context);
  };

  // Phase 5+6: Settings handlers
  const handleSaveApiKey = () => {
    if (settingsForm.apiKey.trim()) {
      // Save both API key AND current provider setting
      vscode.postMessage({
        command: 'saveApiKey',
        payload: { 
          apiKey: settingsForm.apiKey.trim(),
          provider: settingsForm.provider  // Include current provider
        }
      });
      setSettingsForm(prev => ({ ...prev, apiKey: '' })); // Clear form for security
    }
  };

  const handleSaveInstructions = () => {
    vscode.postMessage({
      command: 'saveLlmInstructions',
      payload: { 
        instructions: settingsForm.instructions,
        // Also send current provider to ensure it's preserved
        provider: settingsForm.provider
      }
    });
  };

  const handleSaveSettings = () => {
    vscode.postMessage({
      command: 'saveLlmSettings',
      payload: {
        provider: settingsForm.provider,
        model: settingsForm.model,
        maxTokens: settingsForm.maxTokens,
        temperature: settingsForm.temperature
      }
    });
  };

  const handleTestConnection = () => {
    vscode.postMessage({ command: 'testApiConnection' });
  };

  // Phase 5+6: Generate commit message
  const handleGenerateMessage = () => {
    if (!appState.currentGroup) return;
    
    console.log('[Webview App] Requesting commit message generation');
    vscode.postMessage({
      command: 'generateCommitMessage',
      payload: {
        files: appState.currentGroup.files,
        generalContext: appState.generalContext,
        groupContext: appState.currentGroup.specificContext
      }
    });
  };

  // Render Settings View
  const renderSettingsView = () => (
    <div className="app-container">
      {/* Settings header with back button */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--vscode-sideBar-border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button 
          className="secondary-button" 
          onClick={() => handleNavigateToView('fileselection')}
          style={{ fontSize: '11px', padding: '2px 6px' }}
        >
          ← Back
        </button>
        <span style={{ fontSize: '13px', fontWeight: '600' }}>LLM Committer Settings</span>
      </div>

      {/* Settings content */}
      <div className="settings-content" style={{ padding: '12px' }}>
        {/* Provider Selection Section */}
        <div className="settings-section" style={{ marginBottom: '20px' }}>
          <h3>AI Provider</h3>
          
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="provider-select">Provider</label>
            <select
              id="provider-select"
              value={settingsForm.provider}
              onChange={(e) => {
                const newProvider = e.target.value as 'openai' | 'anthropic';
                const defaultModel = newProvider === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'gpt-4o-mini';
                setSettingsForm(prev => ({ 
                  ...prev, 
                  provider: newProvider,
                  model: defaultModel
                }));
              }}
              style={{
                width: '100%',
                padding: '4px 8px',
                fontSize: '13px',
                backgroundColor: 'var(--vscode-input-background)',
                color: 'var(--vscode-input-foreground)',
                border: '1px solid var(--vscode-input-border)',
                borderRadius: '2px'
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic (Claude)</option>
            </select>
            <div className="context-help-text">
              Choose between OpenAI's GPT models or Anthropic's Claude models.
            </div>
          </div>
        </div>

        {/* API Key Section */}
        <div className="settings-section" style={{ marginBottom: '20px' }}>
          <h3>{settingsForm.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API Configuration</h3>
          
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="api-key">API Key</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                id="api-key"
                type="password"
                value={settingsForm.apiKey}
                onChange={(e) => setSettingsForm(prev => ({ ...prev, apiKey: e.target.value }))}
                placeholder={
                  appState.settings.hasApiKey ? 
                    "••••••••••••••••" : 
                    settingsForm.provider === 'anthropic' ? 
                      "Enter your Anthropic API key (sk-ant-...)" :
                      "Enter your OpenAI API key (sk-...)"
                }
                style={{ flex: 1 }}
              />
              <button 
                className="primary-button" 
                onClick={handleSaveApiKey}
                disabled={!settingsForm.apiKey.trim()}
                style={{ fontSize: '11px' }}
              >
                Save
              </button>
            </div>
            <div className="context-help-text">
              {appState.settings.hasApiKey ? 
                '✅ API key is configured and stored securely' : 
                `⚠️ ${settingsForm.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key is required for commit message generation`
              }
            </div>
          </div>

          <div style={{ marginBottom: '12px' }}>
            <button 
              className="secondary-button" 
              onClick={handleTestConnection}
              disabled={!appState.settings.hasApiKey}
              style={{ fontSize: '11px' }}
            >
              🔗 Test API Connection
            </button>
          </div>
        </div>

        {/* Model Settings Section */}
        <div className="settings-section" style={{ marginBottom: '20px' }}>
          <h3>Model Configuration</h3>
          
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="model-select">Model</label>
            <select
              id="model-select"
              value={settingsForm.model}
              onChange={(e) => setSettingsForm(prev => ({ ...prev, model: e.target.value }))}
              style={{
                width: '100%',
                padding: '4px 8px',
                fontSize: '13px',
                backgroundColor: 'var(--vscode-input-background)',
                color: 'var(--vscode-input-foreground)',
                border: '1px solid var(--vscode-input-border)',
                borderRadius: '2px'
              }}
            >
              {settingsForm.provider === 'anthropic' ? (
                <>
                  <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku (Recommended)</option>
                  <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
                  <option value="claude-3-haiku-20240307">Claude 3 Haiku</option>
                  <option value="claude-3-sonnet-20240229">Claude 3 Sonnet</option>
                  <option value="claude-3-opus-20240229">Claude 3 Opus</option>
                </>
              ) : (
                <>
                  <option value="gpt-4o-mini">GPT-4o Mini (Recommended)</option>
                  <option value="gpt-4o">GPT-4o</option>
                  <option value="gpt-4-turbo">GPT-4 Turbo</option>
                  <option value="gpt-4">GPT-4</option>
                  <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                </>
              )}
            </select>
            <div className="context-help-text">
              {settingsForm.provider === 'anthropic' ? 
                'Claude 3.5 Haiku offers the best balance of quality and cost for commit messages.' :
                'GPT-4o Mini offers the best balance of quality and cost for commit messages.'
              }
            </div>
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="max-tokens">Max Tokens: {settingsForm.maxTokens}</label>
            <input
              id="max-tokens"
              type="range"
              min="1000"
              max="8000"
              step="500"
              value={settingsForm.maxTokens}
              onChange={(e) => setSettingsForm(prev => ({ ...prev, maxTokens: parseInt(e.target.value) }))}
              style={{ width: '100%' }}
            />
            <div className="context-help-text">
              Maximum tokens for the entire request. Higher values allow more context but cost more.
            </div>
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="temperature">Creativity: {settingsForm.temperature}</label>
            <input
              id="temperature"
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={settingsForm.temperature}
              onChange={(e) => setSettingsForm(prev => ({ ...prev, temperature: parseFloat(e.target.value) }))}
              style={{ width: '100%' }}
            />
            <div className="context-help-text">
              Lower values (0.1-0.3) = more consistent, Higher values (0.7-1.0) = more creative
            </div>
          </div>

          <button 
            className="primary-button" 
            onClick={handleSaveSettings}
            style={{ fontSize: '13px' }}
          >
            Save Model Settings
          </button>
        </div>

        {/* Instructions Section */}
        <div className="settings-section">
          <h3>LLM Instructions</h3>
          
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="llm-instructions">Custom Instructions</label>
            <textarea
              id="llm-instructions"
              value={settingsForm.instructions}
              onChange={(e) => setSettingsForm(prev => ({ ...prev, instructions: e.target.value }))}
              placeholder="Enter custom instructions for the LLM (optional). Default instructions will be used if empty."
              style={{
                width: '100%',
                minHeight: '100px',
                resize: 'vertical',
                boxSizing: 'border-box'
              }}
            />
            <div className="context-help-text">
              {appState.settings.instructionsLength > 0 ? 
                `Current: ${appState.settings.instructionsLength} characters` : 
                'Using default instructions (conventional commits, concise format)'
              }
            </div>
          </div>

          <button 
            className="primary-button" 
            onClick={handleSaveInstructions}
            style={{ fontSize: '13px' }}
          >
            Save Instructions
          </button>
        </div>
      </div>
    </div>
  );

  // Render File Selection View
  const renderFileSelectionView = () => (
    <div className="app-container">
      {/* Test section - can be removed in production */}
      <div style={{ padding: '8px 20px', borderBottom: '1px solid var(--vscode-sideBar-border)' }}>
        <button className="secondary-button" onClick={handleClick}>
          Test: {count}
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
        <h2>Changes</h2>
        
        {/* Toolbar - just refresh and create group */}
        <div style={{ padding: '4px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button 
            className="secondary-button" 
            onClick={handleRefreshChanges} 
            disabled={isLoadingFiles}
            style={{ fontSize: '11px', padding: '2px 6px' }}
          >
            {isLoadingFiles ? '⟳' : '↻'} Refresh
          </button>
          
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

        {isLoadingFiles && appState.changedFiles.length === 0 && (
          <div className="loading-indicator">Loading changes...</div>
        )}

        {!isLoadingFiles && appState.changedFiles.length === 0 && (
          <div className="no-changes-message">No changes detected in the current workspace.</div>
        )}

        {appState.changedFiles.length > 0 && (
          <ul className="file-list">
            {appState.changedFiles.map((file, index) => (
              <li key={index} className={`file-item ${appState.selectedFiles.includes(file) ? 'selected' : ''}`}>
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

      <div className="group-content" style={{ padding: '12px' }}>
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

        <div className="group-section">
          <h3>Files in Group ({appState.currentGroup?.files.length || 0})</h3>
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

        <div className="group-section" style={{ marginBottom: '16px' }}>
          <label htmlFor="group-context">Group Specific Context</label>
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

        <div className="group-section">
          <label htmlFor="commit-message">Commit Message</label>
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
          
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button 
              className="primary-button" 
              onClick={handleGenerateMessage}
              disabled={appState.currentGroup?.isGenerating || !appState.settings.hasApiKey}
              style={{ fontSize: '13px' }}
            >
              {appState.currentGroup?.isGenerating ? '⟳ Generating...' : '🤖 Generate Message'}
            </button>
            <button 
              className="secondary-button" 
              disabled={!appState.currentGroup?.commitMessage?.trim()}
              style={{ fontSize: '13px' }}
            >
              Stage Group
            </button>
          </div>
          
          <div className="context-help-text" style={{ marginTop: '8px' }}>
            {!appState.settings.hasApiKey ? 
              '⚠️ API key required - configure in Settings' :
              'Generate Message will use the general context, group-specific context, and file diffs to create a commit message.'
            }
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
      {appState.currentView === 'settings' && renderSettingsView()}
    </>
  );
};

export default App;