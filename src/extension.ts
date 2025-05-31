// src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { GitService } from './services/GitService';
import { StateService, AppState, StagedGroup } from './services/StateService'; // Import StagedGroup
import { ConfigurationService } from './services/ConfigurationService';
import { LLMService } from './services/LLMService';

let gitService: GitService;
let stateService: StateService;
let configService: ConfigurationService;
let llmService: LLMService;
let llmCommitterViewProvider: LLMCommitterViewProvider | undefined; // Store provider instance


// --- BEGIN PHASE 7 HELPER ---
// Helper to show commit progress/results to the user
function showCommitProgressNotification(message: string, type: 'info' | 'error' | 'warning' = 'info') {
    switch (type) {
        case 'info':
            vscode.window.showInformationMessage(`LLM Committer: ${message}`);
            break;
        case 'error':
            vscode.window.showErrorMessage(`LLM Committer: ${message}`);
            break;
        case 'warning':
            vscode.window.showWarningMessage(`LLM Committer: ${message}`);
            break;
    }
    // Potentially also send a message to webview to display in a dedicated log area
    if (llmCommitterViewProvider && (llmCommitterViewProvider as any)._view) {
        (llmCommitterViewProvider as any)._view.webview.postMessage({
            command: 'commitOperationFeedback',
            payload: { message, type }
        });
    }
}
// --- END PHASE 7 HELPER ---

class LLMCommitterViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'llmCommitterView';
    public _view?: vscode.WebviewView; // Made public for easier access from helper

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        llmCommitterViewProvider = this; // Store instance

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')]
        };

        webviewView.webview.html = this.getWebviewContent(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            console.log('[LLM-Committer] Message received from webview:', message.command, message.payload);
            const payload = message.payload;

            switch (message.command) {
                case 'alert':
                    vscode.window.showInformationMessage(message.text);
                    return;

                case 'uiReady':
                    console.log('[LLM-Committer] Webview reported "uiReady".');
                    await this.initializeUIState();
                    return;

                case 'fetchChanges':
                    console.log('[LLM-Committer] Webview requested "fetchChanges".');
                    await vscode.workspace.saveAll(false);
                    await updateChangedFilesAndNotifyState(this._view);
                    return;

                case 'viewFileDiff':
                    if (payload && payload.filePath) {
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (workspaceFolders && workspaceFolders.length > 0) {
                            const workspaceRootUri = workspaceFolders[0].uri; // Assuming primary workspace
                            // File path from GitService is relative to repo root.
                            // If workspaceRootUri is not repo root, this needs adjustment or GitService needs to return absolute.
                            // For now, assume workspaceRootUri is effectively the repo root for path joining.
                            // A safer way: get repo root from GitService if possible.
                            const fileUri = vscode.Uri.joinPath(workspaceRootUri, payload.filePath);
                            try {
                                await configService.openFileDiff(fileUri);
                            } catch (e) {
                                console.error(`[LLM-Committer] Failed to open diff for ${payload.filePath}:`, e);
                                vscode.window.showErrorMessage(`Failed to open diff for ${path.basename(payload.filePath)}`);
                            }
                        } else {
                            vscode.window.showErrorMessage('LLM Committer: No workspace folder open to view diff.');
                        }
                    }
                    return;

                case 'revertFileChanges':
                    if (payload && payload.filePath) {
                        const confirm = await vscode.window.showWarningMessage(
                            `Are you sure you want to revert all changes to "${path.basename(payload.filePath)}"? This action cannot be undone.`,
                            { modal: true },
                            "Revert Changes"
                        );
                        if (confirm === "Revert Changes") {
                            try {
                                await gitService.revertFile(payload.filePath);
                                vscode.window.showInformationMessage(`Changes to "${path.basename(payload.filePath)}" reverted.`);
                                await updateChangedFilesAndNotifyState(this._view);
                            } catch (error) {
                                vscode.window.showErrorMessage(`Failed to revert "${path.basename(payload.filePath)}": ${(error as Error).message}`);
                            }
                        }
                    }
                    return;

                case 'toggleFileSelection':
                    if (payload && payload.filePath) {
                        stateService.toggleFileSelection(payload.filePath);
                    }
                    return;

                case 'createGroup':
                    if (payload && payload.selectedFiles && payload.selectedFiles.length > 0) {
                        stateService.startNewGroup(payload.selectedFiles);
                    } else {
                        vscode.window.showWarningMessage('No files selected for grouping.');
                    }
                    return;

                case 'navigateToView':
                    if (payload && payload.view) {
                        console.log(`[LLM-Committer] Navigating to view: ${payload.view}`);
                        if (payload.view === 'fileselection') {
                            stateService.clearCurrentGroup(); // Also clears currentEditingStagedGroupId
                        } else {
                            stateService.setCurrentView(payload.view as AppState['currentView']);
                        }
                    }
                    return;

                case 'updateGroupSpecificContext': // For current (new) group
                    if (payload && typeof payload.context === 'string' && stateService.state.currentGroup) {
                        stateService.updateCurrentGroupSpecificContext(payload.context);
                    }
                    return;

                case 'updateGroupCommitMessage': // For current (new) group
                    if (payload && typeof payload.message === 'string' && stateService.state.currentGroup) {
                        stateService.updateCurrentGroupCommitMessage(payload.message);
                    }
                    return;

                case 'updateGeneralContext':
                    if (payload && typeof payload.context === 'string') {
                        stateService.setGeneralContext(payload.context);
                        try {
                            await configService.setGeneralContext(payload.context);
                        } catch (error) {
                            console.error(`[LLM-Committer] Failed to persist general context:`, error);
                        }
                    }
                    return;

                case 'getSettings':
                    const instructions = configService.getLlmInstructions();
                    if (this._view) {
                        this._view.webview.postMessage({
                            command: 'settingsLoaded',
                            payload: { instructions }
                        });
                    }
                    return;

                case 'saveApiKey':
                    if (payload && typeof payload.apiKey === 'string') {
                        try {
                            await configService.setApiKey(payload.apiKey);
                            if (payload.provider) {
                                await configService.setLlmProvider(payload.provider);
                            }
                            await this.updateSettingsState();
                            vscode.window.showInformationMessage('API key saved successfully.');
                        } catch (error) {
                            vscode.window.showErrorMessage(`Failed to save API key: ${(error as Error).message}`);
                        }
                    }
                    return;

                case 'saveLlmInstructions':
                    if (payload && typeof payload.instructions === 'string') {
                        try {
                            await configService.setLlmInstructions(payload.instructions);
                            if (payload.provider) { // Preserve provider if sent
                                await configService.setLlmProvider(payload.provider);
                            }
                            await this.updateSettingsState();
                            vscode.window.showInformationMessage('LLM instructions saved successfully.');
                        } catch (error) {
                            vscode.window.showErrorMessage(`Failed to save LLM instructions: ${(error as Error).message}`);
                        }
                    }
                    return;

                case 'saveLlmSettings':
                    if (payload) {
                        try {
                            if (payload.provider) await configService.setLlmProvider(payload.provider);
                            if (payload.model) await configService.setLlmModel(payload.model);
                            if (payload.maxTokens) await configService.setMaxTokens(payload.maxTokens);
                            if (payload.temperature !== undefined) await configService.setTemperature(payload.temperature);
                            await this.updateSettingsState();
                            vscode.window.showInformationMessage('Model settings saved successfully.');
                        } catch (error) {
                            vscode.window.showErrorMessage(`Failed to save settings: ${(error as Error).message}`);
                        }
                    }
                    return;

                case 'testApiConnection':
                    try {
                        const result = await llmService.testConnection();
                        if (result.success) {
                            vscode.window.showInformationMessage('✅ API connection successful!');
                        } else {
                            vscode.window.showErrorMessage(`❌ API connection failed: ${result.error}`);
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`❌ API connection test failed: ${(error as Error).message}`);
                    }
                    return;

                case 'generateCommitMessage':
                    // This can be for a new group or an existing staged group being edited
                    let filesForLLM: string[] | undefined;
                    let groupContextForLLM: string | undefined;

                    if (stateService.state.currentGroup && payload.files) { // For new group
                        filesForLLM = stateService.state.currentGroup.files;
                        groupContextForLLM = stateService.state.currentGroup.specificContext;
                    } else if (stateService.state.currentEditingStagedGroupId && payload.stagedGroupId) { // For editing staged group
                        const stagedGroup = stateService.state.stagedGroups.find(g => g.id === payload.stagedGroupId);
                        if (stagedGroup) {
                            filesForLLM = stagedGroup.files;
                            groupContextForLLM = payload.groupContext !== undefined ? payload.groupContext : stagedGroup.specificContext;
                        }
                    }

                    if (filesForLLM && groupContextForLLM !== undefined) {
                        await this.handleGenerateCommitMessage(
                            filesForLLM,
                            stateService.getGeneralContext(), // Always use current general context
                            groupContextForLLM,
                            payload.stagedGroupId // Pass stagedGroupId if generating for existing group
                        );
                    } else {
                        vscode.window.showWarningMessage("Could not determine files or context for message generation.");
                    }
                    return;

                // --- BEGIN PHASE 7 MESSAGE HANDLERS ---
                case 'stageCurrentGroup':
                    if (stateService.stageCurrentGroup()) {
                        vscode.window.showInformationMessage('Group staged successfully.');
                        // StateService.clearCurrentGroup already fires state change and sets view.
                    }
                    // Errors handled by StateService via vscode.window.showErrorMessage
                    return;

                case 'commitAllStaged':
                    await this.handleCommitAllStaged();
                    return;

                case 'unstageGroup':
                    if (payload && payload.groupId) {
                        stateService.unstageGroup(payload.groupId);
                        // Message shown by StateService
                    }
                    return;
                
                case 'navigateToReviewStagedGroup':
                    if (payload && payload.groupId) {
                        const groupExists = stateService.state.stagedGroups.some(g => g.id === payload.groupId);
                        if (groupExists) {
                            stateService.setCurrentEditingStagedGroupId(payload.groupId);
                            // setCurrentEditingStagedGroupId also sets currentView to 'reviewStagedGroup'
                        } else {
                            vscode.window.showErrorMessage("Cannot review group: Group not found.");
                            stateService.setCurrentView('fileselection'); // Fallback
                        }
                    }
                    return;

                case 'updateStagedGroup':
                    if (payload && payload.groupId && payload.updates) {
                        // Validate updates before passing to state service if necessary
                        stateService.updateStagedGroup(payload.groupId, payload.updates);
                        vscode.window.showInformationMessage('Staged group updated.');
                    }
                    return;

                case 'removeFileFromStagedGroup':
                    if (payload && payload.groupId && payload.filePath) {
                        stateService.removeFileFromStagedGroup(payload.groupId, payload.filePath);
                        // Message shown by StateService if group becomes empty
                    }
                    return;
                // --- END PHASE 7 MESSAGE HANDLERS ---
            }
        });
    }

    private async handleGenerateCommitMessage(
        files: string[],
        generalContext: string,
        groupContext: string,
        stagedGroupIdForUpdate?: string // Optional: if generating for an existing staged group
    ): Promise<void> {
        try {
            if (stagedGroupIdForUpdate) {
                // UI should show its own loading indicator for editing staged group
                if (this._view) {
                     this._view.webview.postMessage({ command: 'generatingStagedGroupMessage', payload: { groupId: stagedGroupIdForUpdate, isGenerating: true } });
                }
            } else {
                 stateService.setGeneratingMessage(true); // For new group
            }


            const fileDiffs = await gitService.getFileDiffs(files);
            const result = await llmService.generateCommitMessage({
                generalContext,
                groupContext,
                fileDiffs
            });

            if (result.success && result.message) {
                if (stagedGroupIdForUpdate) {
                    stateService.updateStagedGroup(stagedGroupIdForUpdate, { commitMessage: result.message });
                } else {
                    stateService.updateCurrentGroupCommitMessage(result.message);
                }

                let successMsg = '✅ Commit message generated!';
                if (result.truncated) successMsg += ' (Note: Some content truncated)';
                if (result.tokensUsed) successMsg += ` (${result.tokensUsed} tokens)`;
                vscode.window.showInformationMessage(successMsg);

            } else {
                const errorMsg = result.error || 'Unknown error during generation';
                vscode.window.showErrorMessage(`Failed to generate commit message: ${errorMsg}`);
            }

        } catch (error) {
            vscode.window.showErrorMessage(`Error generating commit message: ${(error as Error).message}`);
        } finally {
            if (stagedGroupIdForUpdate) {
                 if (this._view) {
                     this._view.webview.postMessage({ command: 'generatingStagedGroupMessage', payload: { groupId: stagedGroupIdForUpdate, isGenerating: false } });
                }
            } else {
                stateService.setGeneratingMessage(false);
            }
        }
    }

    // --- BEGIN PHASE 7 METHOD ---
    private async handleCommitAllStaged(): Promise<void> {
        const stagedGroupsToCommit = [...stateService.state.stagedGroups]; // Create a copy
        if (stagedGroupsToCommit.length === 0) {
            showCommitProgressNotification('No groups staged for commit.', 'info');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `You are about to commit ${stagedGroupsToCommit.length} group(s). Proceed?`,
            { modal: true },
            "Commit All"
        );
        if (confirm !== "Commit All") {
            showCommitProgressNotification('Commit operation cancelled by user.', 'info');
            return;
        }

        showCommitProgressNotification(`Starting to commit ${stagedGroupsToCommit.length} group(s)...`, 'info');
        if (this._view) {
            this._view.webview.postMessage({ command: 'commitOperationStart', payload: { totalGroups: stagedGroupsToCommit.length }});
        }

        let successCount = 0;
        let failureCount = 0;

        for (const group of stagedGroupsToCommit) {
            const groupIdentifier = `Group for "${group.commitMessage.substring(0, 30)}..."`;
            try {
                showCommitProgressNotification(`Staging files for ${groupIdentifier}...`, 'info');
                await gitService.stageFiles(group.files);

                showCommitProgressNotification(`Committing ${groupIdentifier}...`, 'info');
                await gitService.commit(group.commitMessage);

                stateService.removeStagedGroupById(group.id); // Remove from state on success
                successCount++;
                showCommitProgressNotification(`Successfully committed ${groupIdentifier}.`, 'info');
                 if (this._view) {
                    this._view.webview.postMessage({ command: 'commitGroupSuccess', payload: { groupId: group.id }});
                }

            } catch (error) {
                failureCount++;
                const errorMessage = (error as Error).message || 'Unknown error';
                showCommitProgressNotification(`Failed to commit ${groupIdentifier}: ${errorMessage}`, 'error');
                console.error(`[LLM-Committer] Error committing group ${group.id}:`, error);
                // Group remains in stagedGroups list in StateService
                 if (this._view) {
                    this._view.webview.postMessage({ command: 'commitGroupFailed', payload: { groupId: group.id, error: errorMessage }});
                }
            }
        }

        let finalMessage = `Commit operation finished. ${successCount} succeeded, ${failureCount} failed.`;
        showCommitProgressNotification(finalMessage, failureCount > 0 ? 'warning' : 'info');
        if (this._view) {
            this._view.webview.postMessage({ command: 'commitOperationEnd', payload: { successCount, failureCount }});
        }

        // Refresh changed files list after all attempts
        await updateChangedFilesAndNotifyState(this._view);
    }
    // --- END PHASE 7 METHOD ---

    private async initializeUIState(): Promise<void> {
        try {
            const generalContext = await configService.getGeneralContext();
            stateService.setGeneralContext(generalContext);
            await this.updateSettingsState();
            // stateService.loadStagedGroups(); // Already called in activate via stateService.initialize
            await updateChangedFilesAndNotifyState(this._view);

            if (this._view) {
                this._view.webview.postMessage({
                    command: 'stateUpdate',
                    payload: stateService.state
                });
            }
        } catch (error) {
            console.error('[LLM-Committer] Error initializing UI state:', error);
            if (this._view) {
                this._view.webview.postMessage({
                    command: 'stateUpdate',
                    payload: stateService.state // Send current (possibly partial) state
                });
            }
        }
    }

    private async updateSettingsState(): Promise<void> {
        try {
            const hasApiKey = !!(await configService.getApiKey());
            const settings = {
                hasApiKey,
                provider: configService.getLlmProvider(),
                model: configService.getLlmModel(),
                maxTokens: configService.getMaxTokens(),
                temperature: configService.getTemperature(),
                instructionsLength: configService.getLlmInstructions().length
            };
            stateService.updateSettings(settings);
        } catch (error) {
            console.error('[LLM-Committer] Error updating settings state:', error);
        }
    }

    private getWebviewContent(webview: vscode.Webview): string {
        // const webviewBuildDiskPath = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview');
        const webviewDistPath = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview');
        const indexPathOnDisk = vscode.Uri.joinPath(webviewDistPath, 'index.html');
        const indexPath = vscode.Uri.joinPath(webviewDistPath, 'index.html');

        try {
            let html = fs.readFileSync(indexPath.fsPath, 'utf8');
            html = html.replace(/\${webview.cspSource}/g, webview.cspSource);
    
            // Regex to find asset paths. Handles:
            // - href="./assets/..." or src="./assets/..."
            // - href="assets/..." or src="assets/..." (less common from Vite default)
            // - href="/assets/..." or src="/assets/..." (common from Vite with base: '/')
            const assetRegex = /(href|src)=["']((?:\.\/|\/)?assets\/[^"']+)["']/g;
    
            html = html.replace(assetRegex, (match, p1Attribute, p2Path) => {
                // p2Path is the path as it appears in index.html (e.g., "./assets/...", "/assets/...")
                let assetPathInDist = p2Path;
                if (assetPathInDist.startsWith('/')) {
                    // If path starts with '/', it's relative to the Vite root, which is 'webview' source,
                    // but after build, it's relative to 'dist/webview'. So, remove the leading slash.
                    assetPathInDist = assetPathInDist.substring(1);
                } else if (assetPathInDist.startsWith('./')) {
                    // If path starts with './', remove it as joinPath handles it.
                    assetPathInDist = assetPathInDist.substring(2);
                }
                // Now assetPathInDist should be like "assets/file.js"
    
                const diskPath = vscode.Uri.joinPath(webviewDistPath, assetPathInDist);
                const webviewUri = webview.asWebviewUri(diskPath);
                
                console.log(`[LLM-Committer] Asset Transform: Original Path: ${p2Path} -> Webview URI: ${webviewUri.toString()}`);
                return `${p1Attribute}="${webviewUri.toString()}"`;
            });
            
            // console.log('[LLM-Committer] Final Webview HTML:', html.substring(0, 600)); // For debugging
            return html;
        } catch (e) {
            console.error('[LLM-Committer] Error loading or processing webview HTML:', e);
            vscode.window.showErrorMessage('Failed to load LLM Committer webview content: ' + (e as Error).message);
            return `<h1>Error loading webview content</h1><p>${(e as Error).message}</p><p>Please ensure the webview was built correctly (npm run build:webview).</p>`;
        }
    }

    public async refresh() {
        if (this._view) {
            await vscode.workspace.saveAll(false);
            await updateChangedFilesAndNotifyState(this._view);
            // Potentially re-send full state if needed, or webview relies on incremental updates
             this._view.webview.postMessage({
                command: 'stateUpdate',
                payload: stateService.state
            });
        }
    }
}

async function updateChangedFilesAndNotifyState(view?: vscode.WebviewView) {
    if (!gitService || !stateService) {
        console.warn('[LLM-Committer] Services not initialized for file update.');
        return;
    }
    try {
        const files = await gitService.getChangedFiles();
        stateService.setChangedFiles(files); // This now also handles staged group file validation
        // StateService.setChangedFiles will fire onStateChanged, so no explicit postMessage here
    } catch (error) {
        console.error("[LLM-Committer] Failed to update changed files:", error);
        vscode.window.showErrorMessage('Error fetching Git changes: ' + (error as Error).message);
        stateService.setChangedFiles([]); // Ensure state is cleared on error
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('[LLM-Committer] Extension "llm-committer" is now active!');

    gitService = new GitService();
    stateService = new StateService();
    configService = new ConfigurationService(context);
    llmService = new LLMService(configService);

    stateService.initialize(context); // Initialize StateService with context for persistence

    const provider = new LLMCommitterViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(LLMCommitterViewProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true } // Persist webview state
        })
    );

    const stateChangeSubscription = stateService.onStateChanged(newState => {
        if (llmCommitterViewProvider && llmCommitterViewProvider._view) {
            llmCommitterViewProvider._view.webview.postMessage({ command: 'stateUpdate', payload: newState });
        }
    });
    context.subscriptions.push(stateChangeSubscription);

    const fileWatcher = vscode.workspace.onDidSaveTextDocument(async (document) => {
        // Only refresh if the saved document is within the workspace
        // and not, for example, a VS Code settings file.
        if (vscode.workspace.getWorkspaceFolder(document.uri)) {
            console.log('[LLM-Committer] File saved, refreshing changes list...');
            if (llmCommitterViewProvider) { // Check if provider is initialized
                await llmCommitterViewProvider.refresh();
            }
        }
    });
    context.subscriptions.push(fileWatcher);
    
    // Watch for changes in .git/index to detect external commits/stages
    // This is more complex and might require a file system watcher on .git/HEAD or .git/index
    // For now, manual refresh and save-triggered refresh are primary.
    // Consider `vscode.workspace.createFileSystemWatcher('**/.git/index')` for Phase 8

    const refreshCommand = vscode.commands.registerCommand('llm-committer.refresh', async () => {
        if (llmCommitterViewProvider) {
            await llmCommitterViewProvider.refresh();
        }
    });
    context.subscriptions.push(refreshCommand);

    const settingsCommand = vscode.commands.registerCommand('llm-committer.settings', () => {
        stateService.setCurrentView('settings');
    });
    context.subscriptions.push(settingsCommand);
}

export function deactivate() {
    console.log('[LLM-Committer] Extension "llm-committer" is now deactivated.');
    llmCommitterViewProvider = undefined; // Clear the stored provider instance
}