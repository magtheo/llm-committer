// src/services/ConfigurationService.ts - Phase 5+6: Complete Configuration Management
import * as vscode from 'vscode';

export interface LLMSettings {
    apiKey: string;
    instructions: string;
    provider: 'openai' | 'anthropic';
    model: string;
    maxTokens: number;
    temperature: number;
}

export class ConfigurationService {
    private context: vscode.ExtensionContext;
    private readonly CONFIG_SECTION = 'llmCommitter';
    private readonly SECRET_KEY_API = 'llmCommitter.apiKey';

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

    // API Key - stored securely using SecretStorage
    public async getApiKey(): Promise<string> {
        try {
            const apiKey = await this.context.secrets.get(this.SECRET_KEY_API);
            return apiKey || '';
        } catch (error) {
            console.error('[ConfigService] Error reading API key:', error);
            return '';
        }
    }

    public async setApiKey(apiKey: string): Promise<void> {
        try {
            if (apiKey.trim()) {
                await this.context.secrets.store(this.SECRET_KEY_API, apiKey.trim());
                console.log('[ConfigService] API key stored securely');
            } else {
                await this.context.secrets.delete(this.SECRET_KEY_API);
                console.log('[ConfigService] API key cleared');
            }
        } catch (error) {
            console.error('[ConfigService] Error storing API key:', error);
            throw new Error('Failed to store API key securely');
        }
    }

    // LLM Instructions - stored in workspace configuration
    public getLlmInstructions(): string {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        return config.get<string>('llmInstructions', this.getDefaultInstructions());
    }

    public async setLlmInstructions(instructions: string): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        await config.update('llmInstructions', instructions, vscode.ConfigurationTarget.Workspace);
    }

    // LLM Provider Configuration
    public getLlmProvider(): 'openai' | 'anthropic' {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        const provider = config.get<'openai' | 'anthropic'>('llmProvider');
        console.log(`[ConfigService] Getting LLM provider: ${provider || 'openai (default)'}`);
        return provider || 'openai';
    }

    public async setLlmProvider(provider: 'openai' | 'anthropic'): Promise<void> {
        console.log(`[ConfigService] Setting LLM provider to: ${provider}`);
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        await config.update('llmProvider', provider, vscode.ConfigurationTarget.Workspace);
        console.log(`[ConfigService] LLM provider saved to workspace configuration`);
    }

    // LLM Model Configuration
    public getLlmModel(): string {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        const provider = this.getLlmProvider();
        const defaultModel = provider === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'gpt-4o-mini';
        return config.get<string>('llmModel', defaultModel);
    }

    public async setLlmModel(model: string): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        await config.update('llmModel', model, vscode.ConfigurationTarget.Workspace);
    }

    // Max Tokens Configuration
    public getMaxTokens(): number {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        return config.get<number>('maxTokens', 4000);
    }

    public async setMaxTokens(maxTokens: number): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        await config.update('maxTokens', maxTokens, vscode.ConfigurationTarget.Workspace);
    }

    // Temperature Configuration
    public getTemperature(): number {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        return config.get<number>('temperature', 0.3);
    }

    public async setTemperature(temperature: number): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        await config.update('temperature', temperature, vscode.ConfigurationTarget.Workspace);
    }

    // Get all LLM settings at once
    public async getLLMSettings(): Promise<LLMSettings> {
        return {
            apiKey: await this.getApiKey(),
            instructions: this.getLlmInstructions(),
            provider: this.getLlmProvider(),
            model: this.getLlmModel(),
            maxTokens: this.getMaxTokens(),
            temperature: this.getTemperature()
        };
    }

    // Default LLM instructions
    private getDefaultInstructions(): string {
        return `You are an expert at writing clear, concise Git commit messages. Follow these guidelines:

1. Use conventional commit format when appropriate (feat:, fix:, docs:, etc.)
2. Keep the first line under 50 characters
3. Focus on WHAT changed and WHY, not HOW
4. Use imperative mood ("Add feature" not "Added feature")
5. Be specific and descriptive but concise

Generate a single commit message that best summarizes the changes.`;
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

    // Validate API key format (basic validation)
    public validateApiKey(apiKey: string, provider?: 'openai' | 'anthropic'): { valid: boolean; error?: string } {
        if (!apiKey || !apiKey.trim()) {
            return { valid: false, error: 'API key is required' };
        }

        const trimmed = apiKey.trim();
        const currentProvider = provider || this.getLlmProvider();
        
        if (currentProvider === 'openai') {
            // OpenAI API key format validation
            if (trimmed.startsWith('sk-') && trimmed.length >= 20) {
                return { valid: true };
            }
            return { 
                valid: false, 
                error: 'OpenAI API key should start with "sk-" and be at least 20 characters long' 
            };
        } else if (currentProvider === 'anthropic') {
            // Anthropic API key format validation
            if (trimmed.startsWith('sk-ant-') && trimmed.length >= 20) {
                return { valid: true };
            }
            return { 
                valid: false, 
                error: 'Anthropic API key should start with "sk-ant-" and be at least 20 characters long' 
            };
        }

        return { valid: false, error: 'Unknown provider' };
    }

    // Get configuration for display purposes (without sensitive data)
    public getDisplayConfig(): { [key: string]: any } {
        return {
            provider: this.getLlmProvider(),
            model: this.getLlmModel(),
            maxTokens: this.getMaxTokens(),
            temperature: this.getTemperature(),
            hasApiKey: this.getApiKey().then(key => !!key),
            instructionsLength: this.getLlmInstructions().length
        };
    }
}