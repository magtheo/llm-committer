// src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path'; // Needed for joinPath if constructing URIs manually

// Assuming services are in a 'services' subdirectory
import { GitService } from './services/GitService';
import { StateService, AppState } from './services/StateService';

// Module-scoped variables for services and the panel
let gitService: GitService;
let stateService: StateService;
let currentPanel: vscode.WebviewPanel | undefined = undefined;

/**
 * Helper function to load and prepare the HTML content for the webview.
 */
function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const webviewBuildDiskPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    const indexPathOnDisk = vscode.Uri.joinPath(webviewBuildDiskPath, 'index.html');

    try {
        let indexHtml = fs.readFileSync(indexPathOnDisk.fsPath, 'utf8');
        console.log('[LLM-Committer] Original index.html loaded.');

        // Replace CSP source placeholder
        indexHtml = indexHtml.replace(/\${webview.cspSource}/g, webview.cspSource);
        console.log('[LLM-Committer] CSP source replaced.');

        // Regex to match paths like "/assets/filename.ext"
        indexHtml = indexHtml.replace(/(href|src)="(\/assets\/[^"]+)"/g, (match, attr, assetPathWithSlash) => {
            const relativePath = assetPathWithSlash.substring(1);
            const assetDiskPath = vscode.Uri.joinPath(webviewBuildDiskPath, relativePath);
            const assetWebviewUri = webview.asWebviewUri(assetDiskPath);
            console.log(`[LLM-Committer] Rewriting ${attr}: ${assetPathWithSlash} -> ${assetWebviewUri.toString()}`);
            return `${attr}="${assetWebviewUri.toString()}"`;
        });
         // Add another regex for paths like "assets/filename.ext" (without leading slash), just in case
        indexHtml = indexHtml.replace(/(href|src)="(assets\/[^"]+)"/g, (match, attr, relativePath) => {
            const assetDiskPath = vscode.Uri.joinPath(webviewBuildDiskPath, relativePath);
            const assetWebviewUri = webview.asWebviewUri(assetDiskPath);
            console.log(`[LLM-Committer] Rewriting ${attr} (no-slash): ${relativePath} -> ${assetWebviewUri.toString()}`);
            return `${attr}="${assetWebviewUri.toString()}"`;
        });


        return indexHtml;

    } catch (e) {
        console.error('[LLM-Committer] Error loading or processing webview HTML:', e);
        vscode.window.showErrorMessage('Failed to load LLM Committer webview content: ' + (e as Error).message);
        return `<h1>Error loading webview content</h1><p>${(e as Error).message}</p>`;
    }
}

/**
 * Asynchronously fetches changed files and updates the state.
 */
async function updateChangedFilesAndNotifyState() {
    if (!gitService || !stateService) {
        console.warn('[LLM-Committer] Services not initialized. Cannot update changed files.');
        return;
    }
    try {
        console.log('[LLM-Committer] Fetching changed files...');
        const files = await gitService.getChangedFiles();
        stateService.setChangedFiles(files); // This will trigger onStateChanged
        console.log('[LLM-Committer] Changed files fetched and state updated.');
    } catch (error) {
        console.error("[LLM-Committer] Failed to update changed files:", error);
        vscode.window.showErrorMessage('Error fetching Git changes: ' + (error as Error).message);
        // Optionally clear files or set an error state in StateService
        stateService.setChangedFiles([]); // Clear files on error
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('[LLM-Committer] Extension "llm-committer" is now active!');

    // Initialize services
    gitService = new GitService();
    stateService = new StateService();

    // Subscribe to state changes to update the webview
    const stateChangeSubscription = stateService.onStateChanged(newState => {
        if (currentPanel) {
            console.log('[LLM-Committer] State changed, posting "stateUpdate" to webview:', newState);
            currentPanel.webview.postMessage({
                command: 'stateUpdate',
                payload: newState
            });
        } else {
            console.log('[LLM-Committer] State changed, but no active panel to update.');
        }
    });
    context.subscriptions.push(stateChangeSubscription);

    const commandId = 'llm-committer.openWebview';
    const commandHandler = async () => {
        const extensionUri = context.extensionUri;

        if (currentPanel) {
            console.log('[LLM-Committer] Panel already exists, revealing it.');
            currentPanel.reveal(vscode.ViewColumn.One);
            // Optionally, refresh data when panel is revealed if it's been a while
            // For now, we rely on 'uiReady' or 'fetchChanges' from webview
            return;
        }

        console.log('[LLM-Committer] Creating new webview panel.');
        currentPanel = vscode.window.createWebviewPanel(
            'llmCommitterWebview', // Changed ID for clarity
            'LLM Committer',      // Changed Title
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
                // Retain context when hidden (optional, but good for this type of UI)
                retainContextWhenHidden: true,
            }
        );

        currentPanel.webview.html = getWebviewContent(currentPanel.webview, extensionUri);

        // Handle messages from the webview
        currentPanel.webview.onDidReceiveMessage(
            async message => {
                console.log('[LLM-Committer] Message received from webview:', message);
                switch (message.command) {
                    case 'alert':
                        vscode.window.showInformationMessage(message.text);
                        return;
                    case 'uiReady':
                        console.log('[LLM-Committer] Webview reported "uiReady". Fetching initial data.');
                        await updateChangedFilesAndNotifyState();
                        // Also send current state immediately in case data was already fetched
                        // (e.g. if panel was hidden and re-shown, though uiReady is usually for first load)
                        if (currentPanel) { // Re-check currentPanel as it might have been disposed
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
                    // Add more command handlers here as functionality grows
                }
            },
            undefined,
            context.subscriptions
        );

        // Handle panel disposal
        currentPanel.onDidDispose(
            () => {
                console.log('[LLM-Committer] Webview panel disposed.');
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