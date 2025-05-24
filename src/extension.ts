// src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path'; // Ensure path is imported

import { GitService } from './services/GitService';
import { StateService, AppState } from './services/StateService';

let gitService: GitService;
let stateService: StateService;
let currentPanel: vscode.WebviewPanel | undefined = undefined;

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const webviewBuildDiskPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
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

async function updateChangedFilesAndNotifyState() {
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

    const stateChangeSubscription = stateService.onStateChanged(newState => {
        if (currentPanel) {
            currentPanel.webview.postMessage({ command: 'stateUpdate', payload: newState });
        }
    });
    context.subscriptions.push(stateChangeSubscription);

    const commandId = 'llm-committer.openWebview';
    const commandHandler = async () => {
        const extensionUri = context.extensionUri;
        if (currentPanel) {
            currentPanel.reveal(vscode.ViewColumn.One);
            return;
        }

        currentPanel = vscode.window.createWebviewPanel(
            'llmCommitterWebview',
            'LLM Committer',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
                retainContextWhenHidden: true,
            }
        );

        currentPanel.webview.html = getWebviewContent(currentPanel.webview, extensionUri);

        currentPanel.webview.onDidReceiveMessage(
            async message => {
                console.log('[LLM-Committer] Message received from webview:', message);
                const payload = message.payload; // Define payload for convenience

                switch (message.command) {
                    case 'alert':
                        vscode.window.showInformationMessage(message.text);
                        return;
                    case 'uiReady':
                        console.log('[LLM-Committer] Webview reported "uiReady".');
                        await updateChangedFilesAndNotifyState();
                        // Send current state even if no files changed initially
                        if (currentPanel) {
                           currentPanel.webview.postMessage({
                                command: 'stateUpdate',
                                payload: stateService.state
                            });
                        }
                        return;
                    case 'fetchChanges':
                        console.log('[LLM-Committer] Webview requested "fetchChanges".');
                        await updateChangedFilesAndNotifyState();
                        return;

                    // NEW CASES for Phase 2
                    case 'viewFileDiff':
                        if (payload && payload.filePath) {
                            console.log(`[LLM-Committer] Webview requested "viewFileDiff" for: ${payload.filePath}`);
                            const workspaceFolders = vscode.workspace.workspaceFolders;
                            if (workspaceFolders && workspaceFolders.length > 0) {
                                const workspaceRootUri = workspaceFolders[0].uri;
                                const fileUri = vscode.Uri.joinPath(workspaceRootUri, payload.filePath);
                                try {
                                    // Attempt to use the built-in Git SCM 'openChange' command
                                    await vscode.commands.executeCommand('git.openChange', fileUri);
                                    console.log(`[LLM-Committer] Opened SCM diff for: ${payload.filePath}`);
                                } catch (e) {
                                    console.warn(`[LLM-Committer] 'git.openChange' failed for ${payload.filePath}, falling back to 'vscode.open':`, e);
                                    // Fallback to just opening the file; user can use built-in diff tools
                                    await vscode.commands.executeCommand('vscode.open', fileUri);
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
                                    // IMPORTANT: Refresh the file list after reverting
                                    await updateChangedFilesAndNotifyState();
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
                }
            },
            undefined,
            context.subscriptions
        );

        currentPanel.onDidDispose(
            () => {
                currentPanel = undefined;
            },
            null,
            context.subscriptions
        );
    };

    context.subscriptions.push(vscode.commands.registerCommand(commandId, commandHandler));
}

export function deactivate() {
    console.log('[LLM-Committer] Extension "llm-committer" is now deactivated.');
    if (currentPanel) {
        currentPanel.dispose();
    }
}