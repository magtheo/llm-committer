// src/services/ConfigurationService.ts
import * as vscode from 'vscode';

// Define and export LLMProvider outside the class
export const LLM_PROVIDERS = ['openai', 'anthropic', 'gemini', 'openrouter'] as const;
export type LLMProvider = typeof LLM_PROVIDERS[number];

export interface LLMSettings {
    apiKey: string;
    instructions: string;
    provider: LLMProvider; // Uses the exported type
    model: string;
    maxTokens: number;
    temperature: number;
    openRouterRefererUrl?: string;
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
        const configValue = config.get<string>('llmInstructions');
        
        // Use default instructions if config is undefined, null, or empty string
        if (!configValue || configValue.trim() === '') {
            const defaultInstructions = this.getDefaultInstructions();
            console.log('[ConfigService] Using default instructions, length:', defaultInstructions.length);
            return defaultInstructions;
        }
        
        console.log('[ConfigService] Using custom instructions, length:', configValue.length);
        return configValue;
    }

    public async setLlmInstructions(instructions: string): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        await config.update('llmInstructions', instructions, vscode.ConfigurationTarget.Workspace);
    }

    // LLM Provider Configuration
    public getLlmProvider(): LLMProvider {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        const provider = config.get<LLMProvider>('llmProvider');
        console.log(`[ConfigService] Getting LLM provider: ${provider || 'openai (default)'}`);
        return provider || 'openai';
    }

    public async setLlmProvider(provider: LLMProvider): Promise<void> {
        console.log(`[ConfigService] Setting LLM provider to: ${provider}`);
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        await config.update('llmProvider', provider, vscode.ConfigurationTarget.Workspace);
        console.log(`[ConfigService] LLM provider saved to workspace configuration`);
    }

    // LLM Model Configuration
    public getLlmModel(): string {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        const provider = this.getLlmProvider();
        let defaultModel = 'gpt-4o-mini'; // Overall default
        switch (provider) {
            case 'anthropic': defaultModel = 'claude-3-5-sonnet-20240620'; break;
            case 'gemini': defaultModel = 'gemini-1.5-flash-latest'; break;
            case 'openrouter': defaultModel = 'openrouter/auto'; break;
            case 'openai':
            default:
                defaultModel = 'gpt-4o-mini'; break;
        }
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

    // OpenRouter Referer URL
    public getOpenRouterRefererUrl(): string {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        return config.get<string>('openRouterRefererUrl', 'http://localhost');
    }

    // Get all LLM settings at once
    public async getLLMSettings(): Promise<LLMSettings> {
        return {
            apiKey: await this.getApiKey(),
            instructions: this.getLlmInstructions(),
            provider: this.getLlmProvider(),
            model: this.getLlmModel(),
            maxTokens: this.getMaxTokens(),
            temperature: this.getTemperature(),
            openRouterRefererUrl: this.getOpenRouterRefererUrl()
        };
    }

    // Default LLM instructions
    private getDefaultInstructions(): string {
        return `# Git Commit Message Generation Instructions

You are a Git commit message generator. Follow these rules exactly to create properly structured commit messages.

## OUTPUT FORMAT REQUIREMENTS

**CRITICAL**: Always respond with plain text only. Never use markdown code blocks (\`\`\`) or any formatting.

Your response must follow this exact structure:

**For single file changes:**

type: brief description

- Detailed change description explaining what changed and why/how it's better
- Another detailed change description explaining what changed and why/how it's better

**For multiple file changes (MANDATORY format):**

type: brief description

filename1.ext:
- Detailed change description for this file, explaining what changed and how it's different/better
- Another detailed change description for this file, explaining what changed and how it's different/better

filename2.ext:
- Detailed change description for this file, explaining what changed and how it's different/better
- Another detailed change description for this file, explaining what changed and how it's different/better

## COMMIT TYPES

Use exactly one of these types:
- **feat**: New features, functionality or file
- **fix**: Bug fixes
- **refactor**: Code restructuring without changing functionality  
- **style**: Code formatting, whitespace, missing semicolons (no logic changes)
- **docs**: Documentation changes
- **test**: Adding or updating tests
- **chore**: Build process, dependency updates, tooling
- **perf**: Performance improvements
- **ci**: Continuous integration changes
- **build**: Build system or external dependency changes

## STRUCTURE RULES

### Subject Line
- Format: \`type: brief description\`
- Maximum 50 characters
- Use imperative mood ("Add" not "Added")
- No period at the end
- Be specific about what was accomplished

### Body (when multiple changes exist)
- Start immediately after subject line with no blank line
- Organize ALL changes by filename when multiple files are involved
- Use filename exactly as it appears in the diff
- Indent changes with "- " under each filename
- Each change should be descriprive of the change. In other words: Dont just explain what is changed, but how its supiriour or why its done. Example: Dont write: Added MUI components for better UI, rather you would write: Added MUI button, table components for clearer UI that displays x data.
- Use present tense, imperative mood

## CRITICAL RULE: FILE ORGANIZATION

When multiple files are changed, you MUST organize by filename. Never group all changes together.

**WRONG (all changes together):**
feat: optimize ChargerOfflineOverview page
- Added MUI components for better UI
- Implemented enhanced data fetching from APIs  
- Introduced data source selection
- Fixed minor imports and type issues

**CORRECT (organized by file):**
feat: optimize ChargerOfflineOverview page with enhanced data and UI improvements

src/pages/chargerOfflineOverview/ChargerOfflineOverview.tsx:
- Added MUI button, table components for clearer UI that displays x data
- Implement enhanced data fetching from Firebase and Emabler APIs, this allowes us to get data from two sources and compare them.
- Introduce data source selection for faster/slower loading options.
- Display data source statistics and error messages
- Add loading warning for slow data fetching
- Improve error handling and error display
- Add loader while data is being fetched
- Fix minor imports and type issues

## ANALYSIS PROCESS

### Step 1: Deep Code Diff Analysis (CRITICAL)
**Before writing anything, analyze each file's diff line by line:**

- **Examine added lines**: What specific functions, components, variables, or logic was added?
- **Examine removed lines**: What was deleted or replaced?
- **Examine modified lines**: What specific changes were made to existing code?
- **Look for patterns**: Are new imports added? New state variables? New API calls? New UI components?
- **Identify specific implementation details**: Don't just see "data fetching" - see what specific endpoints, parameters, error handling, loading states were added

### Step 2: Determine Primary Commit Type
- Look at all changes across all files
- Choose the most significant type of change
- If adding any new functionality, use \`feat\`
- If only fixing bugs, use \`fix\`
- If only reorganizing code without new features, use \`refactor\`

### Step 3: Write Subject Line
- Summarize the overall purpose in 50 characters or less
- Focus on the business value or main accomplishment
- Use specific terms relevant to the domain

### Step 4: Organize Body by File with SPECIFIC Implementation Details
- List each changed file exactly as named in the diff
- Under each file, describe EXACTLY what code was added/modified/removed
- Be specific about new variables, functions, components, API endpoints, UI elements
- Explain the purpose and benefit of each specific implementation detail

## WRITING GUIDELINES

### CRITICAL: Be Specific About Implementation
Instead of vague descriptions, describe EXACTLY what was implemented:

**VAGUE (Don't do this):**
- "Add MUI components for better UI"
- "Implement enhanced data fetching from APIs"
- "Introduce data source selection"

**SPECIFIC (Do this):**
- "Add MUI Select dropdown component with 'Firebase' and 'Emabler' options for data source selection"
- "Implement fetchFromFirebase() and fetchFromEmabler() functions with separate error handling and loading states"
- "Add dataSource state variable and conditional rendering based on selected source"

### Use These Specific Patterns:
- "Add [SpecificComponent] component with [specific props/functionality]"
- "Implement [specificFunction()] that [specific behavior/parameters]"
- "Add [specificVariable] state to track [specific data/condition]"
- "Create [specificHook/utility] for [specific purpose]"
- "Update [specificFunction] to handle [specific case/parameter]"
- "Add error boundary for [specific error type] with [specific fallback]"

### Examine the Code for These Details:
- **New imports**: What specific libraries/components were imported?
- **New state variables**: What useState, useEffect hooks were added?
- **New functions**: What specific function names and their purposes?
- **New UI components**: What specific MUI/HTML elements with what props?
- **New API calls**: What specific endpoints, parameters, response handling?
- **New conditional logic**: What specific if/else conditions were added?
- **New error handling**: What specific try/catch blocks or error states?

### Avoid These Patterns:
- "Various changes"
- "Updated stuff" 
- "Improvements"
- "Changes to support..."
- Past tense ("Added", "Fixed")
- Vague descriptions

## CONTEXT INTEGRATION

Use provided context to understand the broader purpose, but ALWAYS prioritize the actual code diff for specific implementation details.

**Analysis Priority:**
1. **File diffs (PRIMARY)**: Examine the actual code changes line by line to understand exactly what was implemented
2. **Group-specific context**: Use to understand why these specific changes were made together  
3. **General context**: Use to understand the broader project purpose

**Required Analysis Questions:**
- What specific functions/variables/components were added to the code?
- What specific imports were added and why?
- What specific UI elements were added with what properties?
- What specific state management was implemented?
- What specific error handling was added?
- What specific API integration was implemented?

Each change description should reference ACTUAL code elements visible in the diff, not just conceptual descriptions.

## FINAL CHECKLIST

Before responding, verify:
1. No markdown formatting or code blocks in your response
2. Subject line under 50 characters
3. If multiple files: each file listed separately with its specific changes
4. All changes use present tense, imperative mood
5. Changes are specific and actionable
6. Commit type accurately reflects the most significant change`;
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
    public validateApiKey(apiKey: string, provider?: LLMProvider): { valid: boolean; error?: string } {
        if (!apiKey || !apiKey.trim()) {
            return { valid: false, error: 'API key is required' };
        }

        const trimmed = apiKey.trim();
        const currentProvider = provider || this.getLlmProvider();
        
        if (currentProvider === 'openai') {
            if (trimmed.startsWith('sk-') && trimmed.length >= 20) {
                return { valid: true };
            }
            return { 
                valid: false, 
                error: 'OpenAI API key should start with "sk-" and be at least 20 characters long' 
            };
        } else if (currentProvider === 'anthropic') {
            if (trimmed.startsWith('sk-ant-') && trimmed.length >= 20) {
                return { valid: true };
            }
            return { 
                valid: false, 
                error: 'Anthropic API key should start with "sk-ant-" and be at least 20 characters long' 
            };
        } else if (currentProvider === 'gemini') {
            if (trimmed.length >= 30) { 
                return { valid: true };
            }
            return { valid: false, error: 'Gemini API key seems too short.' };
        } else if (currentProvider === 'openrouter') {
            if (trimmed.startsWith('sk-or-') && trimmed.length >= 20) {
                return { valid: true };
            }
            return { valid: false, error: 'OpenRouter API key should start with "sk-or-".' };
        }
        return { valid: false, error: 'Unknown provider' };
    }

    // Get configuration for display purposes (without sensitive data)
    public getDisplayConfig(): { [key: string]: any } {
        const currentInstructions = this.getLlmInstructions(); // This should include defaults
        console.log('[ConfigService] Display config instructions length:', currentInstructions.length);
        
        return {
            provider: this.getLlmProvider(),
            model: this.getLlmModel(),
            maxTokens: this.getMaxTokens(),
            temperature: this.getTemperature(),
            hasApiKey: this.getApiKey().then(key => !!key), 
            instructionsLength: currentInstructions.length, // Use the actual instructions being used
            openRouterRefererUrl: this.getOpenRouterRefererUrl()
        };
    }
}