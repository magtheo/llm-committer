// src/services/LLMService.ts
import { ConfigurationService, LLMSettings, LLMProvider } from './ConfigurationService';

export interface FileDiff {
    filePath: string;
    content: string;
}

export interface FileSummary {
    filePath: string;
    summary: string;
}

export interface GenerateFileSummaryRequest {
    filePath: string;
    diffContent: string;
    generalContext: string;
}

export interface GenerateOverallMessageRequest {
    fileSummaries: FileSummary[];
    specificContext: string;
    generalContext: string;
}

export interface GenerateFileDiffsForSummaryRequest {
    generalContext: string;
    groupContext: string;
    fileDiffs: FileDiff[];
}

export interface GenerateMessageResponse {
    success: boolean;
    message?: string;
    error?: string;
    tokensUsed?: number;
    truncated?: boolean;
}

export interface TokenInfo {
    estimated: number;
    limit: number;
    withinLimit: boolean;
    truncationSuggested: boolean;
}

type LoggerFunction = (message: string, type?: 'info' | 'error' | 'warning' | 'debug', showPopup?: boolean) => void;

export class LLMService {
    private configService: ConfigurationService;
    private logger: LoggerFunction;
    private readonly OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
    private readonly ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
    private readonly GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
    private readonly OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
    private readonly MAX_DIFF_LENGTH = 5000; // Max length for individual diffs before internal truncation

    constructor(configService: ConfigurationService, logger: LoggerFunction = console.log) {
        this.configService = configService;
        this.logger = logger;
    }

    public async generateFileSummary(request: GenerateFileSummaryRequest): Promise<GenerateMessageResponse> {
        try {
            this.logger(`Starting file summary generation for ${request.filePath}.`, 'debug');
            const settings = await this.configService.getLLMSettings();

            if (!settings.apiKey.trim()) {
                this.logger('API key not configured for the selected provider.', 'error');
                return { success: false, error: 'API key not configured. Please set it up in settings.' };
            }

            let prompt = this.buildFileSummaryPrompt(request, settings.instructions);
            let tokenInfo = this.estimateTokens(prompt, settings.maxTokens);
            let wasTruncated = false;

            if (!tokenInfo.withinLimit) {
                this.logger(`File summary prompt too large (${tokenInfo.estimated}/${tokenInfo.limit}). This should ideally not happen if individual diffs are pre-truncated.`, 'warning');
            }

            return this.routeApiCall(prompt, settings, wasTruncated, true);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger(`Error generating file summary for ${request.filePath}: ${errorMsg}`, 'error', true);
            console.error(`[LLMService] Error generating file summary for ${request.filePath}:`, error);
            return { success: false, error: `Failed to generate file summary: ${errorMsg}` };
        }
    }

    public async generateOverallCommitMessage(request: GenerateOverallMessageRequest): Promise<GenerateMessageResponse> {
        try {
            this.logger('Starting overall commit message generation process.', 'debug');
            const settings = await this.configService.getLLMSettings();
            
            if (!settings.apiKey.trim()) {
                this.logger('API key not configured for the selected provider.', 'error');
                return { success: false, error: 'API key not configured. Please set it up in settings.' };
            }

            let prompt = this.buildOverallCommitMessagePrompt(request, settings.instructions);
            let tokenInfo = this.estimateTokens(prompt, settings.maxTokens);
            let wasTruncated = false; // This flag is now primarily for file summaries, but kept for consistency

            if (!tokenInfo.withinLimit) {
                this.logger(`Overall commit message prompt too large (${tokenInfo.estimated}/${tokenInfo.limit}). This indicates too many file summaries or very long instructions.`, 'warning');
            }

            return this.routeApiCall(prompt, settings, wasTruncated, false);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger(`Error generating overall commit message: ${errorMsg}`, 'error', true);
            console.error('[LLMService] Error generating overall commit message:', error);
            return { success: false, error: `Failed to generate overall commit message: ${errorMsg}` };
        }
    }

    private routeApiCall(prompt: string, settings: LLMSettings, wasTruncated: boolean, isFileSummary: boolean): Promise<GenerateMessageResponse> {
        this.logger(`Routing API call to provider: ${settings.provider}`, 'debug');
        switch (settings.provider) {
            case 'openai':
                return this.callOpenAI(prompt, settings, wasTruncated, isFileSummary);
            case 'anthropic':
                return this.callAnthropic(prompt, settings, wasTruncated, isFileSummary);
            case 'gemini':
                return this.callGemini(prompt, settings, wasTruncated, isFileSummary);
            case 'openrouter':
                return this.callOpenRouter(prompt, settings, wasTruncated, isFileSummary);
            default:
                this.logger(`Unknown provider specified: ${settings.provider}`, 'error');
                console.error(`[LLMService] Unknown provider: ${settings.provider}`); // Keep for dev console
                return Promise.resolve({ success: false, error: `Unknown provider: ${settings.provider}` });
        }
    }

    private buildFileSummaryPrompt(request: GenerateFileSummaryRequest, instructions: string): string {
        this.logger(`Building file summary prompt for ${request.filePath}.`, 'debug');
        const parts = [instructions, ''];
        if (request.generalContext && request.generalContext.trim()) {
            parts.push(`General Project Context:\n${request.generalContext.trim()}`, '');
        }
        parts.push(
            `Summarize the changes in the following file. Focus on what changed and why, providing enough detail to understand the impact of this file's changes on the overall commit. Aim for 2-4 sentences.`,
            `--- File: ${request.filePath} ---`,
            request.diffContent,
            ''
        );
        parts.push(`Detailed summary for ${request.filePath}:`);
        const finalPrompt = parts.join('\n');
        this.logger(`Full file summary prompt (length: ${finalPrompt.length}):\n--BEGIN PROMPT--\n${finalPrompt}\n--END PROMPT--`, 'debug');
        return finalPrompt;
    }

    private buildOverallCommitMessagePrompt(request: GenerateOverallMessageRequest, instructions: string): string {
        this.logger(`Building overall commit message prompt.`, 'debug');
        const parts = [instructions, ''];
        if (request.generalContext && request.generalContext.trim()) {
            parts.push(`General Project Context:\n${request.generalContext.trim()}`, '');
        }
        if (request.specificContext && request.specificContext.trim()) {
            parts.push(`Specific Context for This Change:\n${request.specificContext.trim()}`, '');
        }
        if (request.fileSummaries.length > 0) {
            parts.push('Summaries of Changes in Files:', '');
            request.fileSummaries.forEach(summary => {
                parts.push(`--- File: ${summary.filePath} ---`, summary.summary, '');
            });
        }
        parts.push('Based on the above context and the *provided summaries for each file*, generate a single, comprehensive Git commit message that accurately reflects *all* changes. Focus on the "what" and "why" of the entire group of changes, integrating insights from all file summaries. The message should be suitable for a Git commit log.');
        const finalPrompt = parts.join('\n');
        this.logger(`Full overall commit message prompt (length: ${finalPrompt.length}):\n--BEGIN PROMPT--\n${finalPrompt}\n--END PROMPT--`, 'debug');
        return finalPrompt;
    }
    
    private async callOpenAI(prompt: string, settings: LLMSettings, wasTruncated: boolean, isFileSummary: boolean): Promise<GenerateMessageResponse> {
        const maxOutputTokens = isFileSummary ? 100 : Math.min(150, settings.maxTokens);
        const payload = {
            model: settings.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxOutputTokens,
            temperature: settings.temperature,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        };
        this.logger(`Calling OpenAI API with model: ${settings.model}, max_tokens: ${maxOutputTokens}`, 'debug');
        const response = await fetch(this.OPENAI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(this.parseOpenAIError(response.status, errorData));
        }
        const data = await response.json();
        if (!data.choices || data.choices.length === 0) throw new Error('No response generated from OpenAI');
        const message = data.choices[0].message?.content?.trim();
        if (!message) throw new Error('Empty response from OpenAI');
        this.logger('Successfully generated commit message via OpenAI.', 'debug');
        return { success: true, message, tokensUsed: data.usage?.total_tokens, truncated: wasTruncated };
    }

    private async callAnthropic(prompt: string, settings: LLMSettings, wasTruncated: boolean, isFileSummary: boolean): Promise<GenerateMessageResponse> {
        const maxOutputTokens = isFileSummary ? 100 : Math.min(150, settings.maxTokens);
        const payload = {
            model: settings.model,
            max_tokens: maxOutputTokens,
            temperature: settings.temperature,
            messages: [{ role: 'user', content: prompt }]
        };
        this.logger(`Calling Anthropic API with model: ${settings.model}`, 'debug');
        const response = await fetch(this.ANTHROPIC_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(this.parseAnthropicError(response.status, errorData));
        }
        const data = await response.json();
        if (!data.content || data.content.length === 0) throw new Error('No response generated from Anthropic');
        const message = data.content[0]?.text?.trim();
        if (!message) throw new Error('Empty response from Anthropic');
        this.logger('Successfully generated commit message via Anthropic.', 'debug');
        return { success: true, message, tokensUsed: data.usage?.input_tokens + data.usage?.output_tokens, truncated: wasTruncated };
    }

    private async callGemini(prompt: string, settings: LLMSettings, wasTruncated: boolean, isFileSummary: boolean): Promise<GenerateMessageResponse> {
        const maxOutputTokens = isFileSummary ? 100 : Math.min(150, settings.maxTokens);
        const apiUrl = `${this.GEMINI_API_BASE_URL}/${settings.model}:generateContent?key=${settings.apiKey}`;
        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: settings.temperature,
                maxOutputTokens: maxOutputTokens,
            }
        };
        this.logger(`Calling Gemini API with model: ${settings.model}`, 'debug');
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(this.parseGeminiError(response.status, errorData));
        }
        const data = await response.json();
        if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content?.parts[0]?.text) {
            console.error("[LLMService] Invalid response structure from Gemini:", data); // Keep for dev console
            this.logger('Invalid response structure from Gemini.', 'error');
            throw new Error('No response or invalid format generated from Gemini');
        }
        const message = data.candidates[0].content.parts[0].text.trim();
        if (!message) throw new Error('Empty response from Gemini');
        this.logger('Successfully generated commit message via Gemini.', 'debug');
        return { success: true, message, tokensUsed: undefined, truncated: wasTruncated }; // Gemini doesn't return token usage in this basic call
    }

    private async callOpenRouter(prompt: string, settings: LLMSettings, wasTruncated: boolean, isFileSummary: boolean): Promise<GenerateMessageResponse> {
        const maxOutputTokens = isFileSummary ? 100 : Math.min(150, settings.maxTokens);
        const payload = {
            model: settings.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: settings.temperature,
            max_tokens: maxOutputTokens,
        };
        this.logger(`Calling OpenRouter API with model: ${settings.model}`, 'debug');
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.apiKey}`,
            'X-Title': 'LLM-Committer', // As recommended by OpenRouter
        };
        if (settings.openRouterRefererUrl) {
            headers['HTTP-Referer'] = settings.openRouterRefererUrl;
            this.logger(`Using HTTP-Referer for OpenRouter: ${settings.openRouterRefererUrl}`, 'debug');
        }
        const response = await fetch(this.OPENROUTER_API_URL, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            // OpenRouter often mirrors OpenAI's error format
            throw new Error(this.parseOpenAIError(response.status, errorData));
        }
        const data = await response.json();
        if (!data.choices || data.choices.length === 0 || !data.choices[0].message?.content) {
            throw new Error('No response or invalid format generated from OpenRouter');
        }
        const message = data.choices[0].message.content.trim();
        if (!message) throw new Error('Empty response from OpenRouter');
        this.logger('Successfully generated commit message via OpenRouter.', 'debug');
        return { success: true, message, tokensUsed: data.usage?.total_tokens, truncated: wasTruncated };
    }
    
    private parseAnthropicError(status: number, errorData: any): string {
        const errorMessage = errorData.error?.message || errorData.message || 'Unknown Anthropic error';
        this.logger(`Anthropic API Error (Status ${status}): ${errorMessage}`, 'debug');
        switch (status) {
            case 401: return `Invalid API key. Please check your Anthropic API key. Details: ${errorMessage}`;
            case 429: return `Rate limit exceeded for Anthropic. Please try again later. Details: ${errorMessage}`;
            case 400: return errorMessage.includes('maximum context length') || errorMessage.includes('too long') ? `Request too large for Anthropic. Details: ${errorMessage}` : `Bad request to Anthropic: ${errorMessage}`;
            case 500: case 502: case 503: return `Anthropic service temporarily unavailable. Details: ${errorMessage}`;
            default: return `Anthropic API error (${status}): ${errorMessage}`;
        }
    }

    private parseOpenAIError(status: number, errorData: any): string {
        const errorMessage = errorData.error?.message || errorData.message || 'Unknown OpenAI/OpenRouter error';
        this.logger(`OpenAI/OpenRouter API Error (Status ${status}): ${errorMessage}`, 'debug');
        switch (status) {
            case 401: return `Invalid API key. Please check your API key. Details: ${errorMessage}`;
            case 429: return `Rate limit exceeded. Please try again later. Details: ${errorMessage}`;
            case 400: return errorMessage.includes('maximum context length') ? `Request too large. Details: ${errorMessage}` : `Bad request: ${errorMessage}`;
            case 500: case 502: case 503: return `Service temporarily unavailable. Details: ${errorMessage}`;
            default: return `API error (${status}): ${errorMessage}`;
        }
    }

    private parseGeminiError(status: number, errorData: any): string {
        const errorMessage = errorData.error?.message || errorData.message || 'Unknown Gemini error';
        this.logger(`Gemini API Error (Status ${status}): ${errorMessage}`, 'debug');
        switch (status) {
            case 400:
                if (errorMessage.toLowerCase().includes('api key not valid')) return `Invalid API key for Gemini. Details: ${errorMessage}`;
                if (errorMessage.toLowerCase().includes('user location is not supported')) return `User location not supported for Gemini API. Details: ${errorMessage}`;
                return `Bad request to Gemini: ${errorMessage}`;
            case 429: return `Rate limit exceeded for Gemini. Please try again later. Details: ${errorMessage}`;
            case 500: case 503: return `Gemini service temporarily unavailable. Details: ${errorMessage}`;
            default: return `Gemini API error (${status}): ${errorMessage}`;
        }
    }

    private estimateTokens(text: string, maxTokensFromConfig: number): TokenInfo {
        // Very rough estimate: 1 token ~ 4 chars in English
        const estimated = Math.ceil(text.length / 4);
        // Use a portion of maxTokensFromConfig for the prompt itself, leaving room for the response.
        // The 'max_tokens' in API calls is for the *response*, not the whole request.
        // Let's assume the LLM context window (maxTokensFromConfig) needs to fit prompt + response.
        // We need to define how much of maxTokensFromConfig is for the prompt.
        // For this tool, the response (commit message) is small (e.g., 150 tokens).
        // So, the prompt can take most of maxTokensFromConfig.
        const promptLimit = Math.floor(maxTokensFromConfig * 0.95); // e.g., 95% for prompt, 5% for response (generous for response)

        const withinLimit = estimated <= promptLimit;
        this.logger(`Token estimation: Estimated prompt tokens: ${estimated}, Prompt token limit: ${promptLimit} (derived from total context ${maxTokensFromConfig}). Within limit: ${withinLimit}`, 'debug');
        return { estimated, limit: promptLimit, withinLimit, truncationSuggested: !withinLimit };
    }

    private truncateRequestDiffs(request: GenerateFileDiffsForSummaryRequest): GenerateFileDiffsForSummaryRequest {
        this.logger('Attempting to truncate individual file diffs in the request.', 'debug');
        const truncatedDiffs = request.fileDiffs.map(diff => {
            if (diff.content.length > this.MAX_DIFF_LENGTH) {
                this.logger(`Truncating diff for file: ${diff.filePath} from ${diff.content.length} to ${this.MAX_DIFF_LENGTH} chars.`, 'debug');
                return {
                    ...diff,
                    content: diff.content.substring(0, this.MAX_DIFF_LENGTH) + '\n... (diff content truncated by LLMService)'
                };
            }
            return diff;
        });
        return { ...request, fileDiffs: truncatedDiffs };
    }

    public async testConnection(): Promise<{ success: boolean; error?: string }> {
        this.logger('Testing API connection...', 'debug');
        try {
            const settings = await this.configService.getLLMSettings();
            if (!settings.apiKey) {
                this.logger('API key not found for connection test.', 'warning');
                return { success: false, error: 'No API key configured for the selected provider.' };
            }
            
            const providerName = settings.provider.charAt(0).toUpperCase() + settings.provider.slice(1);
            this.logger(`Testing connection for provider: ${providerName}`, 'debug');

            // Simpler routing for test connection methods
            switch (settings.provider) {
                case 'openai': return this.testOpenaiConnection(settings);
                case 'anthropic': return this.testAnthropicConnection(settings);
                case 'gemini': return this.testGeminiConnection(settings);
                case 'openrouter': return this.testOpenrouterConnection(settings);
                default:
                    this.logger(`Connection test not implemented for provider: ${settings.provider}`, 'warning');
                    return { success: false, error: `Connection test not implemented for provider: ${settings.provider}` };
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger(`Connection test failed: ${errorMsg}`, 'error');
            console.error('[LLMService] Connection test failed:', error); // Keep for dev console stack trace
            return { success: false, error: `Connection failed: ${errorMsg}` };
        }
    }

    private async testOpenaiConnection(settings: LLMSettings): Promise<{ success: boolean; error?: string }> {
        const testModel = settings.model || 'gpt-3.5-turbo'; // Fallback for testing if model isn't set
        const testPayload = { model: testModel, messages: [{ role: 'user', content: 'Test connection. Respond with "OK".' }], max_tokens: 10, temperature: 0 };
        const response = await fetch(this.OPENAI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
            body: JSON.stringify(testPayload)
        });
        if (response.ok) {
            this.logger('OpenAI API connection test successful.', 'debug');
            return { success: true };
        }
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: this.parseOpenAIError(response.status, errorData) };
    }

    private async testAnthropicConnection(settings: LLMSettings): Promise<{ success: boolean; error?: string }> {
        const testModel = settings.model || 'claude-3-haiku-20240307'; // A fast model for testing
        const testPayload = { model: testModel, max_tokens: 10, messages: [{ role: 'user', content: 'Test connection. Respond with "OK".' }] };
        const response = await fetch(this.ANTHROPIC_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(testPayload)
        });
        if (response.ok) {
            this.logger('Anthropic API connection test successful.', 'debug');
            return { success: true };
        }
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: this.parseAnthropicError(response.status, errorData) };
    }

    private async testGeminiConnection(settings: LLMSettings): Promise<{ success: boolean; error?: string }> {
        const testModel = settings.model || 'gemini-1.5-flash-latest'; // A fast model for testing
        const apiUrl = `${this.GEMINI_API_BASE_URL}/${testModel}:generateContent?key=${settings.apiKey}`;
        const testPayload = { contents: [{ parts: [{ text: "Test connection. Respond with 'OK'." }] }], generationConfig: { maxOutputTokens: 10, temperature: 0 } };
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload)
        });
        if (response.ok) {
            const data = await response.json();
            if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
                this.logger('Gemini API connection test successful.', 'debug');
                return { success: true };
            }
            this.logger('Gemini test call succeeded but response format was unexpected.', 'warning');
            return { success: false, error: 'Gemini test call succeeded but response format was unexpected.' };
        }
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: this.parseGeminiError(response.status, errorData) };
    }

    private async testOpenrouterConnection(settings: LLMSettings): Promise<{ success: boolean; error?: string }> {
        // Use a known fast and cheap model for OpenRouter test, ensure prefix if not present
        const testModel = settings.model && settings.model !== 'openrouter/auto' ? settings.model : 'openai/gpt-3.5-turbo';
        const finalTestModel = testModel.includes('/') ? testModel : `openai/${testModel}`; // Default to openai prefix if missing

        const testPayload = { model: finalTestModel, messages: [{ role: 'user', content: 'Test connection. Respond with "OK".' }], max_tokens: 10, temperature: 0 };
        const headers: HeadersInit = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}`, 'X-Title': 'LLM-Committer (Test)'};
        if (settings.openRouterRefererUrl) {
            headers['HTTP-Referer'] = settings.openRouterRefererUrl;
        }
        const response = await fetch(this.OPENROUTER_API_URL, { method: 'POST', headers, body: JSON.stringify(testPayload) });
        if (response.ok) {
            this.logger('OpenRouter API connection test successful.', 'debug');
            return { success: true };
        }
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: this.parseOpenAIError(response.status, errorData) };
    }

    public getAvailableModels(provider: LLMProvider): string[] {
        switch (provider) {
            case 'openai': return ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];
            case 'anthropic': return ['claude-3-5-sonnet-20240620', 'claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'];
            case 'gemini': return ['gemini-1.5-flash-latest', 'gemini-1.5-pro-latest', 'gemini-pro'];
            case 'openrouter': return [ 
                'openrouter/auto', // Recommended default
                'openai/gpt-4o-mini', 'openai/gpt-4o',
                'anthropic/claude-3.5-sonnet', 'anthropic/claude-3-opus-20240620', 'anthropic/claude-3-haiku', 
                'google/gemini-flash-1.5', 'google/gemini-pro-1.5',
                'mistralai/mistral-large', 'mistralai/mistral-7b-instruct', 
                'meta-llama/llama-3-70b-instruct','meta-llama/llama-3-8b-instruct',
            ];
            default: 
                this.logger(`No available models list for provider: ${provider}`, 'warning');
                return [];
        }
    }
}