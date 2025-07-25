// src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { GitService } from './services/GitService';
import { StateService, AppState } from './services/StateService';
import { ConfigurationService } from './services/ConfigurationService';
import { LLMService } from './services/LLMService';

let gitService: GitService;
let stateService: StateService;
let configService: ConfigurationService;
let llmService: LLMService;
let llmCommitterViewProvider: LLMCommitterViewProvider | undefined;

let llmCommitterOutputChannel: vscode.OutputChannel;

export function logToOutputAndNotify( // Exporting so services can potentially use it if defined globally or passed
    message: string,
    type: 'info' | 'error' | 'warning' | 'debug' = 'info',
    showPopup: boolean = false
) {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ${message}`;

    if (!llmCommitterOutputChannel) {
        console.warn("LLM Committer Output Channel not initialized. Message (queued or to console):", logMessage);
        return;
    }

    switch (type) {
        case 'info':
            llmCommitterOutputChannel.appendLine(logMessage);
            break;
        case 'debug':
            llmCommitterOutputChannel.appendLine(`DEBUG: ${logMessage}`);
            break;
        case 'error':
            llmCommitterOutputChannel.appendLine(`ERROR: ${logMessage}`);
            break;
        case 'warning':
            llmCommitterOutputChannel.appendLine(`WARNING: ${logMessage}`);
            break;
    }

    if (showPopup) {
        const prefixedMessage = `LLM Committer: ${message}`;
        switch (type) {
            case 'info':
                vscode.window.showInformationMessage(prefixedMessage);
                break;
            case 'error':
                vscode.window.showErrorMessage(prefixedMessage);
                break;
            case 'warning':
                vscode.window.showWarningMessage(prefixedMessage);
                break;
        }
    }
}

class LLMCommitterViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'llmCommitterView';
    public _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        llmCommitterViewProvider = this;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')]
        };

        webviewView.webview.html = this.getWebviewContent(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            logToOutputAndNotify(`Message received from webview: command='${message.command}'`, 'debug');
            if (message.payload && Object.keys(message.payload).length > 0) {
                 logToOutputAndNotify(`Webview message payload: ${JSON.stringify(message.payload)}`, 'debug');
            }
            const payload = message.payload;

            switch (message.command) {
                case 'alert':
                    vscode.window.showInformationMessage(message.text);
                    return;

                case 'uiReady':
                    logToOutputAndNotify('Webview reported "uiReady". Initializing UI state.', 'debug');
                    await this.initializeUIState();
                    return;

                case 'fetchChanges':
                    logToOutputAndNotify('Webview requested "fetchChanges".', 'debug');
                    await vscode.workspace.saveAll(false);
                    await updateChangedFilesAndNotifyState(this._view);
                    return;

                case 'viewFileDiff':
                    if (payload && payload.filePath) {
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (workspaceFolders && workspaceFolders.length > 0) {
                            const workspaceRootUri = workspaceFolders[0].uri;
                            const fileUri = vscode.Uri.joinPath(workspaceRootUri, payload.filePath);
                            try {
                                await configService.openFileDiff(fileUri);
                            } catch (e) {
                                const errorMsg = e instanceof Error ? e.message : String(e);
                                console.error(`[LLM-Committer] Failed to open diff for ${payload.filePath}:`, e);
                                logToOutputAndNotify(`Failed to open diff for ${path.basename(payload.filePath)}: ${errorMsg}`, 'error', true);
                            }
                        } else {
                            logToOutputAndNotify('No workspace folder open to view diff.', 'warning', true);
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
                                logToOutputAndNotify(`Changes to "${path.basename(payload.filePath)}" reverted.`, 'info', true);
                                await updateChangedFilesAndNotifyState(this._view);
                            } catch (error) {
                                logToOutputAndNotify(`Failed to revert "${path.basename(payload.filePath)}": ${(error as Error).message}`, 'error', true);
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
                        logToOutputAndNotify('No files selected for grouping.', 'warning', true);
                    }
                    return;

                case 'navigateToView':
                    if (payload && payload.view) {
                        logToOutputAndNotify(`Navigating to view: ${payload.view}`, 'debug');
                        if (payload.view === 'fileselection') {
                            stateService.clearCurrentGroup();
                        } else {
                            stateService.setCurrentView(payload.view as AppState['currentView']);
                        }
                    }
                    return;

                case 'updateGroupSpecificContext': // This might be deprecated if local state in webview is primary
                    if (payload && typeof payload.context === 'string' && stateService.state.currentGroup) {
                        stateService.updateCurrentGroupSpecificContext(payload.context);
                    }
                    return;

                case 'updateGroupCommitMessage': // This might be deprecated if local state in webview is primary
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
                            const errorMsg = error instanceof Error ? error.message : String(error);
                            console.error(`[LLM-Committer] Failed to persist general context:`, error);
                            logToOutputAndNotify(`Failed to persist general context: ${errorMsg}`, 'error');
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
                            logToOutputAndNotify('API key saved successfully.', 'info', true);
                        } catch (error) {
                            logToOutputAndNotify(`Failed to save API key: ${(error as Error).message}`, 'error', true);
                        }
                    }
                    return;

                case 'saveLlmInstructions':
                    if (payload && typeof payload.instructions === 'string') {
                        try {
                            await configService.setLlmInstructions(payload.instructions);
                            if (payload.provider) {
                                await configService.setLlmProvider(payload.provider);
                            }
                            await this.updateSettingsState();
                            logToOutputAndNotify('LLM instructions saved successfully.', 'info', true);
                        } catch (error) {
                            logToOutputAndNotify(`Failed to save LLM instructions: ${(error as Error).message}`, 'error', true);
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
                            logToOutputAndNotify('Model settings saved successfully.', 'info', true);
                        } catch (error) {
                            logToOutputAndNotify(`Failed to save settings: ${(error as Error).message}`, 'error', true);
                        }
                    }
                    return;

                case 'testApiConnection':
                    try {
                        const result = await llmService.testConnection();
                        if (result.success) {
                            logToOutputAndNotify('✅ API connection successful!', 'info', true);
                        } else {
                            logToOutputAndNotify(`❌ API connection failed: ${result.error}`, 'error', true);
                        }
                    } catch (error) {
                        logToOutputAndNotify(`❌ API connection test failed: ${(error as Error).message}`, 'error', true);
                    }
                    return;

                case 'generateCommitMessage':
                    let filesForLLM: string[] | undefined;
                    let groupContextForLLM: string | undefined;

                    // For new group generation, use specific context from payload
                    if (stateService.state.currentGroup && payload.files && payload.currentGroupSpecificContext !== undefined) {
                        filesForLLM = stateService.state.currentGroup.files;
                        groupContextForLLM = payload.currentGroupSpecificContext;
                        // The StateService's currentGroup.specificContext will be updated when staging or if user blurs/saves it.
                        // For generation, we use the immediate context from the webview.
                    } else if (stateService.state.currentEditingStagedGroupId && payload.stagedGroupId && payload.files) { // For staged group editing
                        const stagedGroup = stateService.state.stagedGroups.find(g => g.id === payload.stagedGroupId);
                        if (stagedGroup) {
                            filesForLLM = payload.files || stagedGroup.files;
                            groupContextForLLM = payload.groupContext !== undefined ? payload.groupContext : stagedGroup.specificContext;
                        }
                    }

                    if (filesForLLM && groupContextForLLM !== undefined) {
                        await this.handleGenerateCommitMessage(
                            filesForLLM,
                            stateService.getGeneralContext(),
                            groupContextForLLM,
                            payload.stagedGroupId // Will be undefined for new groups, present for staged groups
                        );
                    } else {
                        logToOutputAndNotify("Could not determine files or context for message generation.", 'warning', true);
                    }
                    return;

                case 'stageCurrentGroup':
                    if (payload && payload.commitMessage && payload.specificContext !== undefined && stateService.state.currentGroup) {
                        // Update StateService with the latest message and context from the webview before staging
                        stateService.updateCurrentGroupCommitMessage(payload.commitMessage);
                        stateService.updateCurrentGroupSpecificContext(payload.specificContext);
                        
                        if (stateService.stageCurrentGroup()) {
                            logToOutputAndNotify('Group staged successfully with latest details.', 'info', false);
                        }
                    } else {
                        logToOutputAndNotify('Stage current group command received without necessary payload (commitMessage, specificContext) or no current group.', 'warning', true);
                    }
                    return;

                case 'commitAllStaged':
                    await this.handleCommitAllStaged();
                    return;

                case 'unstageGroup':
                    if (payload && payload.groupId) {
                        stateService.unstageGroup(payload.groupId);
                    }
                    return;
                
                case 'navigateToReviewStagedGroup':
                    if (payload && payload.groupId) {
                        const groupExists = stateService.state.stagedGroups.some(g => g.id === payload.groupId);
                        if (groupExists) {
                            stateService.setCurrentEditingStagedGroupId(payload.groupId);
                        } else {
                            logToOutputAndNotify("Cannot review group: Group not found.", 'error', true);
                            stateService.setCurrentView('fileselection');
                        }
                    }
                    return;

                case 'updateStagedGroup':
                    if (payload && payload.groupId && payload.updates) {
                        stateService.updateStagedGroup(payload.groupId, payload.updates);
                        logToOutputAndNotify('Staged group updated.', 'info', false);
                    }
                    return;

                case 'removeFileFromStagedGroup':
                    if (payload && payload.groupId && payload.filePath) {
                        stateService.removeFileFromStagedGroup(payload.groupId, payload.filePath);
                    }
                    return;
            }
        });
    }

    private async handleGenerateCommitMessage(
        files: string[],
        generalContext: string,
        groupContext: string,
        stagedGroupIdForUpdate?: string
    ): Promise<void> {
        let isGeneratingForStagedGroup = !!stagedGroupIdForUpdate;
        try {
            if (isGeneratingForStagedGroup) {
                if (this._view) {
                    this._view.webview.postMessage({ command: 'generatingStagedGroupMessage', payload: { groupId: stagedGroupIdForUpdate, isGenerating: true } });
                }
            } else {
                stateService.setGeneratingMessage(true);
            }

            logToOutputAndNotify(`Starting commit message generation for ${files.length} file(s)...`, 'debug');

            // Step 1: Get file diffs
            const fileDiffs = await gitService.getFileDiffs(files);
            if (fileDiffs.length === 0) {
                logToOutputAndNotify('No file diffs found for selected files.', 'warning', true);
                return;
            }

            // Step 2: Generate summaries for each file
            const fileSummaries: { filePath: string; summary: string }[] = [];
            let totalTokensUsed = 0;

            for (let i = 0; i < fileDiffs.length; i++) {
                const diff = fileDiffs[i];
                logToOutputAndNotify(`Generating summary for file ${i + 1}/${fileDiffs.length}: ${diff.filePath}`, 'debug');
                if (this._view) {
                    this._view.webview.postMessage({ command: 'updateGenerationProgress', payload: { message: `Summarizing file ${i + 1} of ${fileDiffs.length}...`, percentage: Math.floor((i / fileDiffs.length) * 50) } });
                }

                const summaryResult = await llmService.generateFileSummary({
                    filePath: diff.filePath,
                    diffContent: diff.content,
                    generalContext: generalContext
                });

                if (summaryResult.success && summaryResult.message) {
                    fileSummaries.push({ filePath: diff.filePath, summary: summaryResult.message });
                    if (summaryResult.tokensUsed) totalTokensUsed += summaryResult.tokensUsed;
                } else {
                    const errorMsg = summaryResult.error || 'Unknown error';
                    logToOutputAndNotify(`Failed to generate summary for ${diff.filePath}: ${errorMsg}`, 'warning');
                    // Continue with other files, but note the failure
                    fileSummaries.push({ filePath: diff.filePath, summary: `Could not summarize changes for ${diff.filePath}.` });
                }
            }

            // Step 3: Generate overall commit message from file summaries
            logToOutputAndNotify('Generating overall commit message from file summaries...', 'debug');
            if (this._view) {
                this._view.webview.postMessage({ command: 'updateGenerationProgress', payload: { message: 'Synthesizing final commit message...', percentage: 75 } });
            }

            const overallMessageResult = await llmService.generateOverallCommitMessage({
                fileSummaries: fileSummaries,
                specificContext: groupContext,
                generalContext: generalContext
            });

            if (overallMessageResult.success && overallMessageResult.message) {
                if (stagedGroupIdForUpdate) {
                    stateService.updateStagedGroup(stagedGroupIdForUpdate, { commitMessage: overallMessageResult.message });
                } else {
                    stateService.updateCurrentGroupCommitMessage(overallMessageResult.message);
                }

                let successMsg = '✅ Commit message generated!';
                if (overallMessageResult.truncated) successMsg += ' (Note: Some content truncated)';
                if (overallMessageResult.tokensUsed) totalTokensUsed += overallMessageResult.tokensUsed;
                if (totalTokensUsed > 0) successMsg += ` (Total tokens: ${totalTokensUsed})`;
                logToOutputAndNotify(successMsg, 'info', true);

            } else {
                const errorMsg = overallMessageResult.error || 'Unknown error during overall message generation';
                logToOutputAndNotify(`Failed to generate overall commit message: ${errorMsg}`, 'error', true);
            }

        } catch (error) {
            const errorInst = error as Error;
            logToOutputAndNotify(`Error during commit message generation process: ${errorInst.message}`, 'error', true);
            console.error("Error in handleGenerateCommitMessage:", errorInst);
        } finally {
            if (isGeneratingForStagedGroup) {
                if (this._view) {
                    this._view.webview.postMessage({ command: 'generatingStagedGroupMessage', payload: { groupId: stagedGroupIdForUpdate, isGenerating: false } });
                }
            } else {
                stateService.setGeneratingMessage(false);
            }
            if (this._view) {
                this._view.webview.postMessage({ command: 'updateGenerationProgress', payload: { message: '', percentage: 100 } }); // Clear progress
            }
        }
    }

    private async handleCommitAllStaged(): Promise<void> {
        const stagedGroupsToCommit = [...stateService.state.stagedGroups];
        if (stagedGroupsToCommit.length === 0) {
            logToOutputAndNotify('No groups staged for commit.', 'info', true);
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `You are about to commit ${stagedGroupsToCommit.length} group(s). Proceed?`,
            { modal: true },
            "Commit All"
        );
        if (confirm !== "Commit All") {
            logToOutputAndNotify('Commit operation cancelled by user.', 'info', true);
            return;
        }

        logToOutputAndNotify(`Starting to commit ${stagedGroupsToCommit.length} group(s)...`, 'debug');
        if (this._view) {
            this._view.webview.postMessage({ command: 'commitOperationStart', payload: { totalGroups: stagedGroupsToCommit.length }});
        }

        let successCount = 0;
        let failureCount = 0;

        for (const group of stagedGroupsToCommit) {
            const groupIdentifier = `Group for "${group.commitMessage.substring(0, 30)}..."`;
            try {
                logToOutputAndNotify(`Staging ${group.files.length} file(s) for ${groupIdentifier}...`, 'debug');
                await gitService.stageFiles(group.files);

                logToOutputAndNotify(`Committing ${groupIdentifier}...`, 'debug');
                await gitService.commit(group.commitMessage);

                stateService.removeStagedGroupById(group.id);
                successCount++;
                logToOutputAndNotify(`Successfully committed ${groupIdentifier}.`, 'info', true);
                 if (this._view) {
                    this._view.webview.postMessage({ command: 'commitGroupSuccess', payload: { groupId: group.id }});
                }

            } catch (error) {
                failureCount++;
                const errorInst = error as Error;
                const errorMessage = errorInst.message || 'Unknown error';
                logToOutputAndNotify(`Failed to commit ${groupIdentifier}: ${errorMessage}`, 'error', true);
                console.error(`[LLM-Committer] Error committing group ${group.id} (${groupIdentifier}):`, errorInst);
                 if (this._view) {
                    this._view.webview.postMessage({ command: 'commitGroupFailed', payload: { groupId: group.id, error: errorMessage }});
                }
            }
        }
        
        let finalMessageType: 'info' | 'warning' | 'error' = 'info';
        if (failureCount > 0 && successCount === 0) finalMessageType = 'error';
        else if (failureCount > 0) finalMessageType = 'warning';

        let finalMessage = `Commit operation finished. ${successCount} succeeded, ${failureCount} failed.`;
        logToOutputAndNotify(finalMessage, finalMessageType, true);

        if (this._view) {
            this._view.webview.postMessage({ command: 'commitOperationEnd', payload: { successCount, failureCount }});
        }

        await updateChangedFilesAndNotifyState(this._view);
    }

    private async initializeUIState(): Promise<void> {
        try {
            const generalContext = await configService.getGeneralContext();
            stateService.setGeneralContext(generalContext);
            await this.updateSettingsState();
            await updateChangedFilesAndNotifyState(this._view);

            if (this._view) {
                this._view.webview.postMessage({
                    command: 'stateUpdate',
                    payload: stateService.state
                });
            }
        } catch (error) {
            const errorInst = error as Error;
            console.error('[LLM-Committer] Error initializing UI state:', errorInst);
            logToOutputAndNotify(`Error initializing UI: ${errorInst.message}`, 'error');
            if (this._view) {
                this._view.webview.postMessage({
                    command: 'stateUpdate',
                    payload: stateService.state
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
                instructionsLength: configService.getLlmInstructions().length,
                openRouterRefererUrl: configService.getOpenRouterRefererUrl()
            };
            stateService.updateSettings(settings);
        } catch (error) {
            const errorInst = error as Error;
            console.error('[LLM-Committer] Error updating settings state:', errorInst);
            logToOutputAndNotify(`Error updating internal settings state: ${errorInst.message}`, 'warning');
        }
    }

    private getWebviewContent(webview: vscode.Webview): string {
        const webviewDistPath = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview');
        const indexPath = vscode.Uri.joinPath(webviewDistPath, 'index.html');

        try {
            let html = fs.readFileSync(indexPath.fsPath, 'utf8');
            html = html.replace(/\${webview.cspSource}/g, webview.cspSource);
    
            const assetRegex = /(href|src)=["']((?:\.\/|\/)?assets\/[^"']+)["']/g;
    
            html = html.replace(assetRegex, (match, p1Attribute, p2Path) => {
                let assetPathInDist = p2Path;
                if (assetPathInDist.startsWith('/')) {
                    assetPathInDist = assetPathInDist.substring(1);
                } else if (assetPathInDist.startsWith('./')) {
                    assetPathInDist = assetPathInDist.substring(2);
                }
                const diskPath = vscode.Uri.joinPath(webviewDistPath, assetPathInDist);
                const webviewUri = webview.asWebviewUri(diskPath);
                return `${p1Attribute}="${webviewUri.toString()}"`;
            });
            return html;
        } catch (e) {
            const errorInst = e as Error;
            console.error('[LLM-Committer] Error loading or processing webview HTML:', errorInst);
            logToOutputAndNotify('Failed to load LLM Committer webview content: ' + errorInst.message, 'error', true);
            return `<h1>Error loading webview content</h1><p>${errorInst.message}</p><p>Please ensure the webview was built correctly (npm run build:webview).</p>`;
        }
    }

    public async refresh() {
        if (this._view) {
            logToOutputAndNotify("Refreshing webview data...", 'debug');
            await vscode.workspace.saveAll(false);
            await updateChangedFilesAndNotifyState(this._view);
        }
    }
}

async function updateChangedFilesAndNotifyState(view?: vscode.WebviewView) {
    if (!gitService || !stateService) {
        console.warn('[LLM-Committer] Services not initialized for file update.');
        logToOutputAndNotify('Services not ready for Git file update.', 'warning');
        return;
    }
    try {
        const files = await gitService.getChangedFiles();
        stateService.setChangedFiles(files);
    } catch (error) {
        const errorInst = error as Error;
        console.error("[LLM-Committer] Failed to update changed files:", errorInst);
        logToOutputAndNotify('Error fetching Git changes: ' + errorInst.message, 'error', true);
        stateService.setChangedFiles([]);
    }
}

export function activate(context: vscode.ExtensionContext) {
    llmCommitterOutputChannel = vscode.window.createOutputChannel("LLM Committer");
    context.subscriptions.push(llmCommitterOutputChannel);
    
    logToOutputAndNotify("LLM Committer extension activating...", "info");

    const logger = logToOutputAndNotify; // Use a local const for clarity

    gitService = new GitService(logger);
    stateService = new StateService(logger);
    configService = new ConfigurationService(context, logger);
    llmService = new LLMService(configService, logger);

    stateService.initialize(context);

    const provider = new LLMCommitterViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(LLMCommitterViewProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    const stateChangeSubscription = stateService.onStateChanged(newState => {
        if (llmCommitterViewProvider && llmCommitterViewProvider._view) {
            llmCommitterViewProvider._view.webview.postMessage({ command: 'stateUpdate', payload: newState });
        }
    });
    context.subscriptions.push(stateChangeSubscription);

    const fileWatcher = vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (vscode.workspace.getWorkspaceFolder(document.uri)) {
            logToOutputAndNotify(`File saved: ${path.basename(document.uri.fsPath)}, refreshing changes.`, 'debug');
            if (llmCommitterViewProvider) {
                await llmCommitterViewProvider.refresh();
            }
        }
    });
    context.subscriptions.push(fileWatcher);
    
    const refreshCommand = vscode.commands.registerCommand('llm-committer.refresh', async () => {
        logToOutputAndNotify("Refresh command triggered.", 'debug');
        if (llmCommitterViewProvider) {
            await llmCommitterViewProvider.refresh();
        }
    });
    context.subscriptions.push(refreshCommand);

    const settingsCommand = vscode.commands.registerCommand('llm-committer.settings', () => {
        logToOutputAndNotify("Settings command triggered, navigating to settings view.", 'debug');
        stateService.setCurrentView('settings');
    });
    context.subscriptions.push(settingsCommand);
    logToOutputAndNotify("LLM Committer extension activated successfully.", "info");
}

export function deactivate() {
    logToOutputAndNotify("LLM Committer extension deactivated.", "info");
    llmCommitterViewProvider = undefined;
    if (llmCommitterOutputChannel) {
        llmCommitterOutputChannel.dispose();
    }
}