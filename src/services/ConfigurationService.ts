// src/services/ConfigurationService.ts - Phase 4: Configuration & Persistence
import * as vscode from 'vscode';

export class ConfigurationService {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    // General Context - stored per workspace
    public async getGeneralContext(): Promise<string> {
        return this.context.workspaceState.get('llmCommitter.generalContext', '');
    }

    public async setGeneralContext(context: string): Promise<void> {
        await this.context.workspaceState.update('llmCommitter.generalContext', context);
    }

    // API Key - stored securely (will be implemented in Phase 5)
    public async getApiKey(): Promise<string> {
        // Placeholder for Phase 5 - will use SecretStorage
        return '';
    }

    public async setApiKey(apiKey: string): Promise<void> {
        // Placeholder for Phase 5 - will use SecretStorage
        console.log('[ConfigService] API key setting will be implemented in Phase 5');
    }

    // LLM Instructions - stored as user/workspace setting (will be implemented in Phase 5)
    public getLlmInstructions(): string {
        // Placeholder for Phase 5 - will use workspace configuration
        return '';
    }

    public async setLlmInstructions(instructions: string): Promise<void> {
        // Placeholder for Phase 5 - will use workspace configuration
        console.log('[ConfigService] LLM instructions setting will be implemented in Phase 5');
    }

    // Utility method to open VS Code diff view
    public async openFileDiff(fileUri: vscode.Uri): Promise<void> {
        try {
            await vscode.commands.executeCommand('git.openChange', fileUri);
        } catch (error) {
            // Fallback to regular file open if git.openChange fails
            await vscode.commands.executeCommand('vscode.open', fileUri);
        }
    }
}