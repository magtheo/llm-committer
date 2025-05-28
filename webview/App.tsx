// webview/App.tsx
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import './App.css';

const vscode = (window as any).acquireVsCodeApi();

interface StagedGroup {
  id: string;
  files: string[];
  specificContext: string;
  commitMessage: string;
}

interface CurrentGroup {
    files: string[];
    specificContext: string;
    commitMessage?: string;
    isGenerating?: boolean;
}

interface AppState {
    changedFiles: string[];
    currentGroup: CurrentGroup | null;
    currentView: 'fileselection' | 'group' | 'settings' | 'reviewStagedGroup';
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
    stagedGroups: StagedGroup[];
    currentEditingStagedGroupId: string | null;
}

interface CommitOperationFeedback {
  message: string;
  type: 'info' | 'error' | 'warning';
  timestamp: number;
}

interface EditingStagedGroupState {
  specificContext: string;
  commitMessage: string;
  files: string[]; // Keep a local copy of files for editing
  isGeneratingMessage: boolean;
}


const App: React.FC = () => {
  // Count state is for testing, can be removed later
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
    },
    stagedGroups: [],
    currentEditingStagedGroupId: null,
  });
  const [isLoadingFiles, setIsLoadingFiles] = useState(true);

  const [settingsForm, setSettingsForm] = useState({
    apiKey: '',
    instructions: '',
    provider: 'openai' as 'openai' | 'anthropic',
    model: 'gpt-4o-mini',
    maxTokens: 4000,
    temperature: 0.3
  });

  const [commitFeedback, setCommitFeedback] = useState<CommitOperationFeedback[]>([]);
  const [isCommittingAll, setIsCommittingAll] = useState(false);

  const [editingStagedGroupData, setEditingStagedGroupData] = useState<EditingStagedGroupState | null>(null);


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
    if (appState.currentView === 'settings') {
      console.log('[Webview App] currentView is settings, requesting settings...');
      vscode.postMessage({ command: 'getSettings' });
    } else if (appState.currentView === 'reviewStagedGroup') {
      console.log('[Webview App] currentView is reviewStagedGroup, currentEditingId:', appState.currentEditingStagedGroupId);
      if (appState.currentEditingStagedGroupId) {
        const groupToEdit = appState.stagedGroups.find(g => g.id === appState.currentEditingStagedGroupId);
        console.log('[Webview App] Found groupToEdit for review:', groupToEdit);
        if (groupToEdit) {
          if (!editingStagedGroupData || 
              editingStagedGroupData.commitMessage !== groupToEdit.commitMessage || 
              editingStagedGroupData.specificContext !== groupToEdit.specificContext ||
              JSON.stringify(editingStagedGroupData.files.slice().sort()) !== JSON.stringify(groupToEdit.files.slice().sort())
             ) {
            console.log('[Webview App] Initializing/Updating editingStagedGroupData for:', groupToEdit.id);
            setEditingStagedGroupData({
              specificContext: groupToEdit.specificContext,
              commitMessage: groupToEdit.commitMessage,
              files: [...groupToEdit.files], 
              isGeneratingMessage: false, 
            });
          } else {
            console.log('[Webview App] editingStagedGroupData is already up-to-date for:', groupToEdit.id);
          }
        } else {
          console.warn(`[Webview App] In reviewStagedGroup view, but group ID ${appState.currentEditingStagedGroupId} not found in stagedGroups. Navigating back.`);
          handleNavigateToView('fileselection'); // Navigate back if group is gone
        }
      } else {
        console.warn("[Webview App] In reviewStagedGroup view but no currentEditingStagedGroupId. Navigating back.");
        handleNavigateToView('fileselection'); // Navigate back if ID is missing
      }
    } else { 
      // This 'else' covers 'fileselection' and 'group' views (and any other future views not 'settings' or 'reviewStagedGroup')
      if (editingStagedGroupData !== null) {
        console.log(`[Webview App] currentView is ${appState.currentView}, clearing editingStagedGroupData.`);
        setEditingStagedGroupData(null);
      }
    }
  // Dependency array remains the same:
  }, [appState.currentView, appState.currentEditingStagedGroupId, appState.stagedGroups]); 
  

  useEffect(() => {
    const messageListener = (event: MessageEvent) => {
      const message = event.data;
      console.log('[Webview App] Received message:', message.command, message.payload);
      switch (message.command) {
        case 'stateUpdate':
          setAppState(prevAppState => ({
            ...prevAppState,
            ...message.payload
          }));
          setIsLoadingFiles(false);
          
          if (message.payload.settings) {
            setSettingsForm(prev => ({
              ...prev,
              provider: message.payload.settings.provider || 'openai',
              model: message.payload.settings.model || (message.payload.settings.provider === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'gpt-4o-mini'),
              maxTokens: message.payload.settings.maxTokens || 4000,
              temperature: message.payload.settings.temperature !== undefined ? message.payload.settings.temperature : 0.3,
            }));
          }
          break;
        case 'settingsLoaded':
          if (message.payload.instructions !== undefined) {
            setSettingsForm(prev => ({
              ...prev,
              instructions: message.payload.instructions
            }));
          }
          break;
        case 'commitOperationFeedback':
            setCommitFeedback(prev => [...prev, { ...message.payload, timestamp: Date.now() }].slice(-5));
            break;
        case 'commitOperationStart':
            setIsCommittingAll(true);
            setCommitFeedback([]);
            break;
        case 'commitOperationEnd':
            setIsCommittingAll(false);
            break;
        case 'commitGroupSuccess':
            break;
        case 'commitGroupFailed':
            break;
        case 'generatingStagedGroupMessage':
            if (editingStagedGroupData && message.payload.groupId === appState.currentEditingStagedGroupId) {
                setEditingStagedGroupData(prev => prev ? ({...prev, isGeneratingMessage: message.payload.isGenerating}) : null);
            }
            break;
      }
    };
    window.addEventListener('message', messageListener);
    vscode.postMessage({ command: 'uiReady' });

    return () => {
      window.removeEventListener('message', messageListener);
      if (debounceTimeout.current) {
        clearTimeout(debounceTimeout.current);
      }
    };
  }, [editingStagedGroupData, appState.currentEditingStagedGroupId]);

  const handleClick = () => {
    setCount(prevCount => prevCount + 1);
    vscode.postMessage({
      command: 'alert',
      text: `Count is now ${count + 1}`
    });
  };

  const handleRefreshChanges = () => {
    setIsLoadingFiles(true);
    vscode.postMessage({ command: 'fetchChanges' });
  };

  const handleViewDiff = (filePath: string) => {
    vscode.postMessage({
      command: 'viewFileDiff',
      payload: { filePath: filePath }
    });
  };

  const handleRevertFile = (filePath: string) => {
    vscode.postMessage({
      command: 'revertFileChanges',
      payload: { filePath: filePath }
    });
  };

  const handleToggleFileSelection = (filePath: string) => {
    const isStaged = appState.stagedGroups.some(group => group.files.includes(filePath));
    if (isStaged) {
        vscode.postMessage({command: 'alert', text: `${(filePath.split(/[\\/]/).pop() || filePath)} is already in a staged group.`});
        return;
    }
    vscode.postMessage({
      command: 'toggleFileSelection',
      payload: { filePath: filePath }
    });
  };


  const handleCreateGroup = () => {
    if (appState.selectedFiles.length > 0) {
      vscode.postMessage({
        command: 'createGroup',
        payload: { selectedFiles: appState.selectedFiles }
      });
    }
  };

  // --- CORRECTION POINT 1 START ---
  const handleNavigateToView = (view: AppState['currentView']) => {
  // --- CORRECTION POINT 1 END ---
    console.log(`[Webview App] Navigating to view: ${view}`);
    vscode.postMessage({
      command: 'navigateToView',
      payload: { view: view }
    });
  };

  const handleUpdateCurrentGroupSpecificContext = (context: string) => {
    vscode.postMessage({
      command: 'updateGroupSpecificContext',
      payload: { context: context }
    });
  };

  const handleUpdateCurrentGroupCommitMessage = (message: string) => {
    vscode.postMessage({
      command: 'updateGroupCommitMessage',
      payload: { message: message }
    });
  };

  const handleUpdateGeneralContext = (context: string) => {
    setAppState(prev => ({ ...prev, generalContext: context }));
    debouncedUpdateGeneralContext(context);
  };

  const handleSaveApiKey = () => {
    if (settingsForm.apiKey.trim()) {
      vscode.postMessage({
        command: 'saveApiKey',
        payload: { 
          apiKey: settingsForm.apiKey.trim(),
          provider: settingsForm.provider
        }
      });
      setSettingsForm(prev => ({ ...prev, apiKey: '' }));
    }
  };

  const handleSaveInstructions = () => {
    vscode.postMessage({
      command: 'saveLlmInstructions',
      payload: { 
        instructions: settingsForm.instructions,
        provider: settingsForm.provider
      }
    });
  };

  const handleSaveLlmSettings = () => { // Renamed from handleSaveSettings for clarity
    vscode.postMessage({
      command: 'saveLlmSettings', // Ensure extension expects 'saveLlmSettings'
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

  const handleGenerateNewGroupMessage = () => { // Renamed from handleGenerateMessage
    if (!appState.currentGroup) return;
    vscode.postMessage({
      command: 'generateCommitMessage',
      payload: {
        files: appState.currentGroup.files,
        // generalContext & groupContext are read by extension from its state for new group
      }
    });
  };

  const handleStageCurrentGroup = () => {
    if (appState.currentGroup && appState.currentGroup.commitMessage?.trim() && appState.currentGroup.files.length > 0) {
        vscode.postMessage({ command: 'stageCurrentGroup' });
    } else {
        vscode.postMessage({command: 'alert', text: "Commit message and at least one file are required to stage a group."});
    }
  };

  const handleCommitAllStaged = () => {
      if (appState.stagedGroups.length > 0) {
          vscode.postMessage({ command: 'commitAllStaged' });
      } else {
          vscode.postMessage({command: 'alert', text: "No groups are staged for commit."});
      }
  };

  const handleUnstageGroup = (groupId: string) => {
      vscode.postMessage({ command: 'unstageGroup', payload: { groupId } });
  };

  const handleReviewStagedGroup = (groupId: string) => {
      vscode.postMessage({ command: 'navigateToReviewStagedGroup', payload: { groupId } });
  };

  const handleUpdateEditingStagedGroupDataContext = (context: string) => {
      if (editingStagedGroupData) {
          setEditingStagedGroupData(prev => prev ? ({ ...prev, specificContext: context }) : null);
      }
  };
  const handleUpdateEditingStagedGroupDataMessage = (message: string) => {
      if (editingStagedGroupData) {
          setEditingStagedGroupData(prev => prev ? ({ ...prev, commitMessage: message }) : null);
      }
  };
    const handleRemoveFileFromEditingStagedGroup = (filePath: string) => {
        if (editingStagedGroupData) {
            setEditingStagedGroupData(prev => prev ? ({ ...prev, files: prev.files.filter(f => f !== filePath) }) : null);
        }
    };

  const handleSaveChangesToStagedGroup = () => {
    if (appState.currentEditingStagedGroupId && editingStagedGroupData) {
        if (editingStagedGroupData.files.length === 0) {
            vscode.postMessage({command: 'alert', text: "A group must have at least one file. Remove files and then unstage the group if it's no longer needed."});
            return;
        }
        if (!editingStagedGroupData.commitMessage.trim()) {
            vscode.postMessage({command: 'alert', text: "Commit message cannot be empty."});
            return;
        }
        vscode.postMessage({
            command: 'updateStagedGroup',
            payload: {
                groupId: appState.currentEditingStagedGroupId,
                updates: {
                    specificContext: editingStagedGroupData.specificContext,
                    commitMessage: editingStagedGroupData.commitMessage,
                    files: editingStagedGroupData.files,
                }
            }
        });
    }
  };

  const handleGenerateEditedStagedGroupMessage = () => {
    if (appState.currentEditingStagedGroupId && editingStagedGroupData) {
        vscode.postMessage({
            command: 'generateCommitMessage',
            payload: {
                stagedGroupId: appState.currentEditingStagedGroupId,
                files: editingStagedGroupData.files,
                groupContext: editingStagedGroupData.specificContext,
            }
        });
    }
  };

  const availableChangedFiles = useMemo(() => {
    const stagedFilePaths = new Set(appState.stagedGroups.flatMap(g => g.files));
    return appState.changedFiles.filter(f => !stagedFilePaths.has(f));
  }, [appState.changedFiles, appState.stagedGroups]);


  const renderFileSelectionView = () => (
    <div className="app-container">
      <div className="general-context-section">
        <h2>General Context</h2>
        <div style={{ padding: '8px 12px' }}>
          <textarea
            value={appState.generalContext}
            onChange={(e) => handleUpdateGeneralContext(e.target.value)}
            placeholder="Add general context (e.g., feature name, ticket ID)..."
            className="general-context-textarea"
            rows={3}
            style={{ width: '100%', resize: 'vertical', boxSizing: 'border-box', marginBottom: '4px' }}
          />
          <div className="context-help-text">Saved per workspace. Included in all generations.</div>
        </div>
      </div>
      <hr />

      <div className="staged-changes-section">
        <h2>
            Staged Groups ({appState.stagedGroups.length})
            {appState.stagedGroups.length > 0 && (
                 <button
                    className="primary-button"
                    onClick={handleCommitAllStaged}
                    disabled={isCommittingAll || appState.stagedGroups.length === 0}
                    style={{ fontSize: '11px', padding: '2px 8px', marginLeft: '10px', float: 'right', marginRight: '12px' }}
                >
                    {isCommittingAll ? 'Committing...' : `Commit All (${appState.stagedGroups.length})`}
                </button>
            )}
        </h2>
        {isCommittingAll && <div className="loading-indicator" style={{paddingLeft: '12px'}}>Processing commits...</div>}
        {commitFeedback.length > 0 && (
            <div className="commit-feedback-area">
                {commitFeedback.map(fb => (
                    <div key={fb.timestamp} className={`feedback-${fb.type}`}>{(fb.type === 'error' ? '❌ ' : fb.type === 'warning' ? '⚠️ ' : 'ℹ️ ')} {fb.message}</div>
                ))}
            </div>
        )}
        {appState.stagedGroups.length === 0 && !isCommittingAll && (
            <div className="no-changes-message" style={{padding: '8px 12px'}}>No groups are currently staged.</div>
        )}
        {appState.stagedGroups.length > 0 && (
            <ul className="file-list">
                {appState.stagedGroups.map(group => (
                    <li key={group.id} className="staged-group-item" style={{ padding: '4px 12px', borderBottom: '1px solid var(--vscode-sideBar-border)'}}>
                        <div style={{ fontWeight: 'bold', marginBottom: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span title={group.commitMessage} style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1, marginRight: '8px' }}>
                                {(group.commitMessage.split('\n')[0].substring(0, 60) || "Untitled Group")} ({group.files.length} files)
                            </span>
                            <div>
                                <button onClick={() => handleReviewStagedGroup(group.id)} title="Review/Edit Group" className="secondary-button" style={{fontSize: '10px', padding: '1px 4px', marginRight: '4px'}}>Edit</button>
                                <button onClick={() => handleUnstageGroup(group.id)} title="Unstage Group" className="secondary-button revert-button" style={{fontSize: '10px', padding: '1px 4px'}}>Unstage</button>
                            </div>
                        </div>
                        <details>
                            <summary style={{fontSize: '11px', cursor: 'pointer', color: 'var(--vscode-descriptionForeground)'}}>Files in this group</summary>
                            <ul style={{paddingLeft: '15px', fontSize: '12px', listStyleType: 'disc'}}>
                                {group.files.map(file => <li key={file} title={file}>{(file.split(/[\\/]/).pop() || file)}</li>)}
                            </ul>
                        </details>
                    </li>
                ))}
            </ul>
        )}
      </div>
      <hr />

      <div className="changes-section">
        <h2>Available Changes ({availableChangedFiles.length})</h2>
        <div style={{ padding: '4px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            className="secondary-button"
            onClick={handleRefreshChanges}
            disabled={isLoadingFiles}
            style={{ fontSize: '11px', padding: '2px 6px' }}
          >
            {isLoadingFiles ? <span className="loading-spinner">⟳</span> : '↻'} Refresh
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

        {isLoadingFiles && availableChangedFiles.length === 0 && (
          <div className="loading-indicator">Loading changes...</div>
        )}
        {!isLoadingFiles && availableChangedFiles.length === 0 && appState.stagedGroups.length === 0 && (
          <div className="no-changes-message">No uncommitted changes detected.</div>
        )}
        {!isLoadingFiles && availableChangedFiles.length === 0 && appState.stagedGroups.length > 0 && (
          <div className="no-changes-message">All changes are in staged groups.</div>
        )}

        {availableChangedFiles.length > 0 && (
          <ul className="file-list">
            {availableChangedFiles.map((file) => (
              <li key={file} className={`file-item ${appState.selectedFiles.includes(file) ? 'selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={appState.selectedFiles.includes(file)}
                  onChange={() => handleToggleFileSelection(file)}
                  style={{ margin: '0 8px 0 12px' }}
                  aria-label={`Select ${file} for grouping`}
                />
                <span className="file-name" style={{ paddingLeft: '4px' }}>{(file.split(/[\\/]/).pop() || file)}</span> {/* Display basename */}
                <div className="file-actions">
                  <button onClick={() => handleViewDiff(file)} title="Open Changes">Diff</button>
                  <button onClick={() => handleRevertFile(file)} title="Discard Changes" className="revert-button">↶</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
       {/* Test button for development, can be removed */}
       <div style={{ padding: '8px 20px', borderTop: '1px solid var(--vscode-sideBar-border)', marginTop:'10px' }}>
        <button className="secondary-button" onClick={handleClick}>
          Test Increment: {count}
        </button>
      </div>
    </div>
  );

  const renderGroupView = () => (
    <div className="app-container">
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--vscode-sideBar-border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button className="secondary-button" onClick={() => handleNavigateToView('fileselection')} style={{ fontSize: '11px', padding: '2px 6px' }}>Back</button>
        <span style={{ fontSize: '13px', fontWeight: '600' }}>Create Commit Group</span>
      </div>
      <div className="group-content" style={{ padding: '12px' }}>
        {appState.generalContext && (
          <div className="group-section">
            <label>General Context (Applied)</label>
            <div className="context-preview">"{appState.generalContext}"</div>
          </div>
        )}
        <div className="group-section">
          <h3>Files in New Group ({appState.currentGroup?.files.length || 0})</h3>
          <ul className="file-list" style={{ marginBottom: '16px' }}>
            {appState.currentGroup?.files.map((file) => (
              <li key={file} className="file-item">
                <span className="file-name">{(file.split(/[\\/]/).pop() || file)}</span>
                <div className="file-actions"><button onClick={() => handleViewDiff(file)} title="Diff">⎕</button></div>
              </li>
            ))}
          </ul>
        </div>
        <div className="group-section">
          <label htmlFor="new-group-context">Group Specific Context</label>
          <textarea
            id="new-group-context"
            value={appState.currentGroup?.specificContext || ''}
            onChange={(e) => handleUpdateCurrentGroupSpecificContext(e.target.value)}
            placeholder="Context specific to this new group..."
            style={{ width: '100%', minHeight: '60px', resize: 'vertical', boxSizing: 'border-box' }}
          />
        </div>
        <div className="group-section">
          <label htmlFor="new-commit-message">Commit Message</label>
          <textarea
            id="new-commit-message"
            value={appState.currentGroup?.commitMessage || ''}
            onChange={(e) => handleUpdateCurrentGroupCommitMessage(e.target.value)}
            placeholder="Commit message (will be generated or write manually)..."
            style={{ width: '100%', minHeight: '80px', resize: 'vertical', boxSizing: 'border-box', marginBottom: '12px' }}
          />
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              className="primary-button"
              // --- CORRECTION POINT 2.A START ---
              onClick={handleGenerateNewGroupMessage}
              disabled={appState.currentGroup?.isGenerating || !appState.settings.hasApiKey || (appState.currentGroup?.files.length ?? 0) === 0}
              // --- CORRECTION POINT 2.A END ---
            >
              {appState.currentGroup?.isGenerating ? <span className="loading-spinner">⟳ Generating...</span> : '🤖 Generate Message'}
            </button>
            {/* --- CORRECTION POINT 2.B START --- */}
            <button
              className="secondary-button"
              onClick={handleStageCurrentGroup}
              disabled={!appState.currentGroup?.commitMessage?.trim() || (appState.currentGroup?.files.length ?? 0) === 0}
              style={{ fontSize: '13px' }}
            >
            {/* --- CORRECTION POINT 2.B END --- */}
              Stage Group
            </button>
          </div>
          {!appState.settings.hasApiKey && <div className="warning-state" style={{fontSize: '11px', marginTop: '8px'}}>⚠️ API key required - configure in Settings.</div>}
        </div>
      </div>
    </div>
  );

  const renderReviewEditStagedGroupView = () => {
    // If the necessary data for this view isn't populated yet by the useEffect, show a loading indicator.
    // The useEffect hook is responsible for populating `editingStagedGroupData` or
    // navigating away if the state is irrecoverably inconsistent.
    if (!editingStagedGroupData || !appState.currentEditingStagedGroupId) {
        console.log(`[Webview App] renderReviewEditStagedGroupView: Waiting for data or navigating. currentEditingId: ${appState.currentEditingStagedGroupId}, editingDataPopulated: ${!!editingStagedGroupData}`);
        // It's possible the useEffect is about to navigate away. Showing "Loading..." is safe.
        return <div className="loading-indicator">Loading group details...</div>;
    }

    // Find the original group from appState.stagedGroups for unsaved changes detection.
    // It's possible originalGroup is undefined if the group was deleted from appState.stagedGroups
    // after this view was entered but before a re-render. The UI should be robust to this.
    const originalGroup = appState.stagedGroups.find(g => g.id === appState.currentEditingStagedGroupId);

    const hasUnsavedChanges = originalGroup && editingStagedGroupData && (
        editingStagedGroupData.commitMessage !== originalGroup.commitMessage ||
        editingStagedGroupData.specificContext !== originalGroup.specificContext ||
        JSON.stringify(editingStagedGroupData.files.slice().sort()) !== JSON.stringify(originalGroup.files.slice().sort())
    );

    return (
        <div className="app-container review-edit-group-view"> {/* Added a class for specific styling if needed */}
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--vscode-sideBar-border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button 
                  className="secondary-button" 
                  onClick={() => handleNavigateToView('fileselection')} 
                  style={{ fontSize: '11px', padding: '2px 6px' }}
                  title="Back to file selection"
                >
                    Back
                </button>
                <span style={{ fontSize: '13px', fontWeight: '600' }}>Review/Edit Staged Group</span>
                {hasUnsavedChanges && <span className="unsaved-indicator">(Unsaved Changes)</span>}
            </div>

            <div className="group-content" style={{ padding: '12px' }}>
                {appState.generalContext && (
                    <div className="group-section">
                        <label>General Context (Applied)</label>
                        <div className="context-preview">"{appState.generalContext}"</div>
                    </div>
                )}

                <div className="group-section">
                    <h3>Files in Group ({editingStagedGroupData.files.length})</h3>
                    {editingStagedGroupData.files.length === 0 && 
                        <div className="warning-state" style={{fontSize: '12px', marginBottom:'8px'}}>
                            ⚠️ No files in this group. This group will be unstaged if saved without files.
                        </div>
                    }
                    <ul className="file-list" style={{ marginBottom: '16px', maxHeight: '150px', overflowY: 'auto', border: '1px solid var(--vscode-input-border)' }}>
                        {editingStagedGroupData.files.map((file) => (
                            <li key={file} className="file-item" style={{padding: '2px 6px'}}> {/* Added slight padding to list items */}
                                <span className="file-name" title={file}>{(file.split(/[\\/]/).pop() || file)}</span>
                                <div className="file-actions always-visible"> {/* Make actions always visible in edit view */}
                                    <button onClick={() => handleViewDiff(file)} title="View Diff for this file">Diff</button>
                                    <button 
                                        onClick={() => handleRemoveFileFromEditingStagedGroup(file)} 
                                        title="Remove from group" 
                                        className="revert-button" // Uses error color
                                        style={{fontWeight:'bold', fontSize: '14px'}} // Make cross more prominent
                                    >
                                        ✕
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                    {/* Future: Add button/mechanism to add more files from 'availableChangedFiles' to this group */}
                </div>

                 <div className="group-section">
                    <label htmlFor="edit-group-context">Group Specific Context</label>
                    <textarea
                        id="edit-group-context"
                        value={editingStagedGroupData.specificContext}
                        onChange={(e) => handleUpdateEditingStagedGroupDataContext(e.target.value)}
                        placeholder="Enter context specific to this group..."
                        className="general-context-textarea" // Reuse existing style
                        rows={3}
                    />
                </div>

                <div className="group-section">
                    <label htmlFor="edit-commit-message">Commit Message</label>
                    <textarea
                        id="edit-commit-message"
                        value={editingStagedGroupData.commitMessage}
                        onChange={(e) => handleUpdateEditingStagedGroupDataMessage(e.target.value)}
                        placeholder="Edit commit message..."
                        className="general-context-textarea" // Reuse existing style
                        rows={4}
                        style={{ marginBottom: '12px' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                        <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
                            <button
                                className="primary-button"
                                onClick={handleGenerateEditedStagedGroupMessage}
                                disabled={editingStagedGroupData.isGeneratingMessage || !appState.settings.hasApiKey || editingStagedGroupData.files.length === 0}
                                title={!appState.settings.hasApiKey ? "API Key required" : editingStagedGroupData.files.length === 0 ? "Add files to group first" : "Regenerate message with LLM"}
                            >
                                {editingStagedGroupData.isGeneratingMessage ? <><span className="loading-spinner">⟳</span> Regenerating...</> : '🤖 Regenerate'}
                            </button>
                            <button
                                className="primary-button"
                                onClick={handleSaveChangesToStagedGroup}
                                disabled={
                                    editingStagedGroupData.isGeneratingMessage || 
                                    !editingStagedGroupData.commitMessage.trim() || 
                                    !hasUnsavedChanges // Only enable if there are actual changes to save
                                }
                                title={!editingStagedGroupData.commitMessage.trim() ? "Commit message cannot be empty" : !hasUnsavedChanges ? "No changes to save" : "Save changes to this staged group"}
                            >
                                Save Changes
                            </button>
                        </div>
                        <button
                            className="secondary-button revert-button"
                            onClick={() => handleUnstageGroup(appState.currentEditingStagedGroupId!)} // ID is guaranteed by guard clause
                            disabled={editingStagedGroupData.isGeneratingMessage}
                            title="Remove this group from staging"
                        >
                            Unstage Group
                        </button>
                    </div>
                    {!appState.settings.hasApiKey && editingStagedGroupData.files.length > 0 &&
                        <div className="warning-state" style={{fontSize: '11px', marginTop: '8px'}}>
                            ⚠️ API key required for message regeneration. Configure in Settings.
                        </div>
                    }
                    {editingStagedGroupData.files.length === 0 && editingStagedGroupData.commitMessage.trim() &&
                         <div className="warning-state" style={{fontSize: '11px', marginTop: '8px'}}>
                            ⚠️ Saving an empty group is not allowed. Consider unstaging.
                        </div>
                    }
                </div>
            </div>
        </div>
    );
  };

  const renderSettingsView = () => (
    <div className="app-container">
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--vscode-sideBar-border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button className="secondary-button" onClick={() => handleNavigateToView('fileselection')} style={{ fontSize: '11px', padding: '2px 6px' }}>Back</button>
        <span style={{ fontSize: '13px', fontWeight: '600' }}>LLM Committer Settings</span>
      </div>
      <div className="settings-content" style={{ padding: '12px' }}>
        <div className="settings-section">
          <h3>AI Provider</h3>
          <select id="provider-select" value={settingsForm.provider}
            onChange={(e) => {
              const newProvider = e.target.value as 'openai' | 'anthropic';
              const defaultModel = newProvider === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'gpt-4o-mini';
              setSettingsForm(prev => ({ ...prev, provider: newProvider, model: defaultModel }));
            }}
            style={{ width: '100%', padding: '4px 8px' }}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic (Claude)</option>
          </select>
        </div>
        <div className="settings-section">
          <h3>{settingsForm.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API Key</h3>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input id="api-key" type="password" value={settingsForm.apiKey}
              onChange={(e) => setSettingsForm(prev => ({ ...prev, apiKey: e.target.value }))}
              placeholder={appState.settings.hasApiKey ? "••••••••••••••••" : `Enter your ${settingsForm.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key`}
              style={{ flex: 1 }}
            />
            <button className="primary-button" onClick={handleSaveApiKey} disabled={!settingsForm.apiKey.trim()}>Save</button>
          </div>
          <div className="context-help-text">
            {appState.settings.hasApiKey ? '✅ API key configured.' : `⚠️ API key required.`}
          </div>
          <button className="secondary-button" onClick={handleTestConnection} disabled={!appState.settings.hasApiKey} style={{marginTop: '8px'}}>Test Connection</button>
        </div>
        <div className="settings-section">
            <h3>Model Configuration</h3>
            <label htmlFor="model-select" style={{display:'block', marginBottom:'2px'}}>Model</label>
            <select id="model-select" value={settingsForm.model} // Ensure settingsForm.model is valid for current provider
                onChange={(e) => setSettingsForm(prev => ({ ...prev, model: e.target.value }))}
                style={{ width: '100%', padding: '4px 8px', marginBottom:'8px' }}
            >
              {settingsForm.provider === 'anthropic' ? (
                <>
                  <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku (Fast, Good)</option>
                  <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet (Better, Slower)</option>
                  <option value="claude-3-haiku-20240307">Claude 3 Haiku</option>
                  <option value="claude-3-sonnet-20240229">Claude 3 Sonnet</option>
                  <option value="claude-3-opus-20240229">Claude 3 Opus (Best, Slowest)</option>
                </>
              ) : (
                <>
                  <option value="gpt-4o-mini">GPT-4o Mini (Fast, Good)</option>
                  <option value="gpt-4o">GPT-4o (Better, Slower)</option>
                  <option value="gpt-4-turbo">GPT-4 Turbo</option>
                  <option value="gpt-3.5-turbo">GPT-3.5 Turbo (Fastest, Basic)</option>
                </>
              )}
            </select>
            <label htmlFor="max-tokens" style={{display:'block', marginBottom:'2px'}}>Max Tokens: {settingsForm.maxTokens}</label>
            <input id="max-tokens" type="range" min="1000" max="8000" step="500" value={settingsForm.maxTokens}
                onChange={(e) => setSettingsForm(prev => ({ ...prev, maxTokens: parseInt(e.target.value) }))}
                style={{ width: '100%', marginBottom:'8px' }}
            />
            <label htmlFor="temperature" style={{display:'block', marginBottom:'2px'}}>Creativity (Temperature): {settingsForm.temperature}</label>
            <input id="temperature" type="range" min="0" max="1" step="0.1" value={settingsForm.temperature}
                onChange={(e) => setSettingsForm(prev => ({ ...prev, temperature: parseFloat(e.target.value) }))}
                style={{ width: '100%', marginBottom:'12px' }}
            />
            <button className="primary-button" onClick={handleSaveLlmSettings}>Save Model Settings</button>
        </div>
        <div className="settings-section">
          <h3>LLM Instructions</h3>
          <textarea id="llm-instructions" value={settingsForm.instructions}
            onChange={(e) => setSettingsForm(prev => ({ ...prev, instructions: e.target.value }))}
            placeholder="Custom instructions (optional, uses default if empty)..."
            style={{ width: '100%', minHeight: '100px', resize: 'vertical', boxSizing: 'border-box', marginBottom:'8px' }}
          />
           <div className="context-help-text" style={{marginBottom:'8px'}}>
              {appState.settings.instructionsLength > 0 ? `Current: ${appState.settings.instructionsLength} chars` : 'Using default instructions.'}
            </div>
          <button className="primary-button" onClick={handleSaveInstructions}>Save Instructions</button>
        </div>
      </div>
    </div>
  );


  return (
    <>
      {appState.currentView === 'fileselection' && renderFileSelectionView()}
      {appState.currentView === 'group' && renderGroupView()}
      {appState.currentView === 'settings' && renderSettingsView()}
      {/* --- CORRECTION POINT 4 START --- */}
      {appState.currentView === 'reviewStagedGroup' && renderReviewEditStagedGroupView()}
      {/* --- CORRECTION POINT 4 END --- */}
    </>
  );
};

export default App;