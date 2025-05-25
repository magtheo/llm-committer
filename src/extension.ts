// src/extension.ts - Phase 4: General Context & Persistence
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { GitService } from './services/GitService';
import { StateService, AppState } from './services/StateService';
import { ConfigurationService } from './services/ConfigurationService';

let gitService: GitService;
let stateService: StateService;
let configService: ConfigurationService;

class LLMCommitterViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'llmCommitterView';
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')]
        };

        webviewView.webview.html = this.getWebviewContent(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            console.log('[LLM-Committer] Message received from webview:', message);
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
                    await updateChangedFilesAndNotifyState(this._view);
                    return;
                    
                case 'viewFileDiff':
                    if (payload && payload.filePath) {
                        console.log(`[LLM-Committer] Webview requested "viewFileDiff" for: ${payload.filePath}`);
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (workspaceFolders && workspaceFolders.length > 0) {
                            const workspaceRootUri = workspaceFolders[0].uri;
                            const fileUri = vscode.Uri.joinPath(workspaceRootUri, payload.filePath);
                            try {
                                await configService.openFileDiff(fileUri);
                                console.log(`[LLM-Committer] Opened diff for: ${payload.filePath}`);
                            } catch (e) {
                                console.error(`[LLM-Committer] Failed to open diff for ${payload.filePath}:`, e);
                                vscode.window.showErrorMessage(`Failed to open diff for ${path.basename(payload.filePath)}`);
                            }
                        } else {
                            vscode.window.showErrorMessage('LLM Committer: No workspace folder open to view diff.');
                        }
                    } else {
                        console.error('[LLM-Committer] "viewFileDiff" command received without filePath.');
                    }
                    return;
                    
                case 'revertFileChanges':
                    if (payload && payload.filePath) {
                        console.log(`[LLM-Committer] Webview requested "revertFileChanges" for: ${payload.filePath}`);
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
                        } else {
                            console.log('[LLM-Committer] Revert cancelled by user.');
                        }
                    } else {
                        console.error('[LLM-Committer] "revertFileChanges" command received without filePath.');
                    }
                    return;

                // Phase 3: Grouping functionality
                case 'toggleFileSelection':
                    if (payload && payload.filePath) {
                        console.log(`[LLM-Committer] Toggling selection for: ${payload.filePath}`);
                        stateService.toggleFileSelection(payload.filePath);
                    }
                    return;

                case 'createGroup':
                    if (payload && payload.selectedFiles && payload.selectedFiles.length > 0) {
                        console.log(`[LLM-Committer] Creating group with files:`, payload.selectedFiles);
                        stateService.startNewGroup(payload.selectedFiles);
                    } else {
                        vscode.window.showWarningMessage('No files selected for grouping.');
                    }
                    return;

                case 'navigateToView':
                    if (payload && payload.view) {
                        console.log(`[LLM-Committer] Navigating to view: ${payload.view}`);
                        if (payload.view === 'fileselection') {
                            stateService.clearCurrentGroup();
                        } else {
                            stateService.setCurrentView(payload.view);
                        }
                    }
                    return;

                case 'updateGroupSpecificContext':
                    if (payload && typeof payload.context === 'string') {
                        console.log(`[LLM-Committer] Updating group specific context`);
                        stateService.updateCurrentGroupSpecificContext(payload.context);
                    }
                    return;

                case 'updateGroupCommitMessage':
                    if (payload && typeof payload.message === 'string') {
                        console.log(`[LLM-Committer] Updating group commit message`);
                        stateService.updateCurrentGroupCommitMessage(payload.message);
                    }
                    return;

                // Phase 4: General context handling
                case 'updateGeneralContext':
                    if (payload && typeof payload.context === 'string') {
                        console.log(`[LLM-Committer] Updating general context`);
                        stateService.setGeneralContext(payload.context);
                        // Persist to workspace storage
                        try {
                            await configService.setGeneralContext(payload.context);
                            console.log(`[LLM-Committer] General context persisted`);
                        } catch (error) {
                            console.error(`[LLM-Committer] Failed to persist general context:`, error);
                        }
                    }
                    return;
            }
        });
    }

    // Phase 4: Initialize UI state with persisted data
    private async initializeUIState(): Promise<void> {
        try {
            // Load persisted general context
            const generalContext = await configService.getGeneralContext();
            stateService.setGeneralContext(generalContext);
            
            // Update changed files
            await updateChangedFilesAndNotifyState(this._view);
            
            // Send initial state to webview
            if (this._view) {
                this._view.webview.postMessage({
                    command: 'stateUpdate',
                    payload: stateService.state
                });
            }
        } catch (error) {
            console.error('[LLM-Committer] Error initializing UI state:', error);
            // Still send current state even if loading fails
            if (this._view) {
                this._view.webview.postMessage({
                    command: 'stateUpdate',
                    payload: stateService.state
                });
            }
        }
    }

    private getWebviewContent(webview: vscode.Webview): string {
        const webviewBuildDiskPath = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview');
        const indexPathOnDisk = vscode.Uri.joinPath(webviewBuildDiskPath, 'index.html');
        
        try {
            let indexHtml = fs.readFileSync(indexPathOnDisk.fsPath, 'utf8');
            indexHtml = indexHtml.replace(/\${webview.cspSource}/g, webview.cspSource);
            const assetPathRegex1 = /(href|src)="(\/assets\/[^"]+)"/g;
            const assetPathRegex2 = /(href|src)="(assets\/[^"]+)"/g;

            indexHtml = indexHtml.replace(assetPathRegex1, (match, attr, assetPathWithSlash) => {
                const relativePath = assetPathWithSlash.substring(1);
                const assetDiskPath = vscode.Uri.joinPath(webviewBuildDiskPath, relativePath);
                const assetWebviewUri = webview.asWebviewUri(assetDiskPath);
                return `${attr}="${assetWebviewUri.toString()}"`;
            });
            indexHtml = indexHtml.replace(assetPathRegex2, (match, attr, relativePath) => {
                const assetDiskPath = vscode.Uri.joinPath(webviewBuildDiskPath, relativePath);
                const assetWebviewUri = webview.asWebviewUri(assetDiskPath);
                return `${attr}="${assetWebviewUri.toString()}"`;
            });
            return indexHtml;
        } catch (e) {
            console.error('[LLM-Committer] Error loading or processing webview HTML:', e);
            vscode.window.showErrorMessage('Failed to load LLM Committer webview content: ' + (e as Error).message);
            return `<h1>Error loading webview content</h1><p>${(e as Error).message}</p>`;
        }
    }

    public refresh() {
        if (this._view) {
            updateChangedFilesAndNotifyState(this._view);
        }
    }
}

async function updateChangedFilesAndNotifyState(view?: vscode.WebviewView) {
    if (!gitService || !stateService) {
        console.warn('[LLM-Committer] Services not initialized.');
        return;
    }
    try {
        console.log('[LLM-Committer] Fetching changed files...');
        const files = await gitService.getChangedFiles();
        stateService.setChangedFiles(files);
        console.log('[LLM-Committer] Changed files fetched and state updated.');
    } catch (error) {
        console.error("[LLM-Committer] Failed to update changed files:", error);
        vscode.window.showErrorMessage('Error fetching Git changes: ' + (error as Error).message);
        stateService.setChangedFiles([]);
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('[LLM-Committer] Extension "llm-committer" is now active!');
    
    gitService = new GitService();
    stateService = new StateService();
    configService = new ConfigurationService(context); // Phase 4: Initialize config service

    const provider = new LLMCommitterViewProvider(context.extensionUri);
    
    // Register the webview view provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(LLMCommitterViewProvider.viewType, provider)
    );

    // Register state change listener
    const stateChangeSubscription = stateService.onStateChanged(newState => {
        if (provider && (provider as any)._view) {
            (provider as any)._view.webview.postMessage({ command: 'stateUpdate', payload: newState });
        }
    });
    context.subscriptions.push(stateChangeSubscription);

    // Register refresh command
    const refreshCommand = vscode.commands.registerCommand('llm-committer.refresh', () => {
        provider.refresh();
    });
    context.subscriptions.push(refreshCommand);
}

export function deactivate() {
    console.log('[LLM-Committer] Extension "llm-committer" is now deactivated.');
}