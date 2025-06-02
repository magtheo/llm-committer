// src/services/LLMService.ts
import { ConfigurationService, LLMSettings, LLMProvider } from './ConfigurationService';

export interface FileDiff {
    filePath: string;
    content: string;
}

export interface GenerateMessageRequest {
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

type LoggerFunction = (
    message: string,
    type?: 'info' | 'error' | 'warning' | 'debug',
    showPopup?: boolean
) => void;

export class LLMService {
    private configService: ConfigurationService;
    private logger: LoggerFunction;

    private readonly OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
    private readonly ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
    private readonly GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
    private readonly OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
    private readonly MAX_DIFF_LENGTH_PER_FILE_FOR_LLM = 10000; // Max chars from a single file's diff to include in prompt

    constructor(configService: ConfigurationService, logger: LoggerFunction) {
        this.configService = configService;
        this.logger = logger;
    }

    public async generateCommitMessage(request: GenerateMessageRequest): Promise<GenerateMessageResponse> {
        try {
            this.logger('Starting commit message generation', 'debug');
            const settings = await this.configService.getLLMSettings();
            if (!settings.apiKey.trim()) {
                return {
                    success: false,
                    error: 'API key not configured. Please set it up in settings for the selected provider.'
                };
            }

            let currentRequest = request;
            let prompt = this.buildPrompt(currentRequest, settings.instructions);
            let tokenInfo = this.estimateTokens(prompt, settings.maxTokens);
            let wasTruncatedByLLMService = false;

            if (!tokenInfo.withinLimit) {
                this.logger(`Initial prompt token estimate (${tokenInfo.estimated}) exceeds safe limit (${Math.floor(settings.maxTokens * 0.8)}). Attempting truncation.`, 'warning');
                currentRequest = this.truncateRequest(request); // Truncates individual file diffs
                prompt = this.buildPrompt(currentRequest, settings.instructions);
                tokenInfo = this.estimateTokens(prompt, settings.maxTokens);
                wasTruncatedByLLMService = true;

                if (!tokenInfo.withinLimit) {
                    const errorMsg = `Request too large after truncation. Estimated tokens: ${tokenInfo.estimated}, Max configured: ${settings.maxTokens}. Please reduce context, select fewer/smaller files, or increase maxTokens setting.`;
                    this.logger(errorMsg, 'error', true); // Show popup for this critical error
                    return { success: false, error: errorMsg };
                }
                this.logger('Using truncated request due to token limits. Estimated tokens after truncation: ' + tokenInfo.estimated, 'debug');
            }
            return this.routeApiCall(prompt, settings, wasTruncatedByLLMService);

        } catch (error) {
            const errorMessage = (error as Error).message;
            this.logger(`Error generating commit message: ${errorMessage}`, 'error', true); // Show popup
            return { success: false, error: `Failed to generate commit message: ${errorMessage}` };
        }
    }

    private routeApiCall(prompt: string, settings: LLMSettings, wasTruncated: boolean): Promise<GenerateMessageResponse> {
        const providerName = settings.provider.charAt(0).toUpperCase() + settings.provider.slice(1);
        this.logger(`Routing API call to ${providerName} with model: ${settings.model}`, 'debug');
        switch (settings.provider) {
            case 'openai':
                return this.callOpenAI(prompt, settings, wasTruncated);
            case 'anthropic':
                return this.callAnthropic(prompt, settings, wasTruncated);
            case 'gemini':
                return this.callGemini(prompt, settings, wasTruncated);
            case 'openrouter':
                return this.callOpenRouter(prompt, settings, wasTruncated);
            default:
                this.logger(`Unknown provider encountered: ${settings.provider}`, 'error');
                return Promise.resolve({
                    success: false,
                    error: `Unknown provider: ${settings.provider}`
                });
        }
    }

    private buildPrompt(request: GenerateMessageRequest, instructions: string): string {
        const parts = [instructions, ''];
        if (request.generalContext && request.generalContext.trim()) {
            parts.push(`General Project Context:\n${request.generalContext.trim()}`, '');
        }
        if (request.groupContext && request.groupContext.trim()) {
            parts.push(`Specific Context for This Change:\n${request.groupContext.trim()}`, '');
        }
        if (request.fileDiffs.length > 0) {
            parts.push('Files and Changes:', '');
            request.fileDiffs.forEach(diff => {
                // Diff content comes from GitService.cleanDiffForLLM, which already includes file path and change type.
                parts.push(diff.content, ''); // diff.content already has "Change type: ... File: ..."
            });
        }
        parts.push('Based on the above context and changes, generate a single, concise Git commit message:');
        const finalPrompt = parts.join('\n');

        this.logger("--- LLM PROMPT DIAGNOSTICS (Debug) ---", 'debug');
        this.logger(`Instructions Length: ${instructions.length}`, 'debug');
        this.logger(`General Context (First 100 chars): ${request.generalContext ? request.generalContext.substring(0,100)+(request.generalContext.length > 100 ? '...' : '') : 'N/A'}`, 'debug');
        this.logger(`Group Context (First 100 chars): ${request.groupContext ? request.groupContext.substring(0,100)+(request.groupContext.length > 100 ? '...' : '') : 'N/A'}`, 'debug');
        this.logger(`File Diffs Count: ${request.fileDiffs.length}`, 'debug');
        // For very detailed debugging of the prompt itself (can be very long):
        // this.logger(`Full Prompt (first 500 chars):\n ${finalPrompt.substring(0,500)}`, 'debug');
        this.logger("--- END LLM PROMPT DIAGNOSTICS ---", 'debug');

        return finalPrompt;
    }

    private async callOpenAI(prompt: string, settings: LLMSettings, wasTruncated: boolean): Promise<GenerateMessageResponse> {
        const payload = {
            model: settings.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: Math.min(150, settings.maxTokens), // Max response tokens, not prompt
            temperature: settings.temperature,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        };
        this.logger(`Calling OpenAI API. Model: ${settings.model}, Max Response Tokens: ${payload.max_tokens}`, 'debug');
        const response = await fetch(this.OPENAI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ status: response.status, message: response.statusText }));
            throw new Error(this.parseOpenAIError(response.status, errorData));
        }
        const data = await response.json();
        if (!data.choices || data.choices.length === 0) throw new Error('No response generated from OpenAI');
        const message = data.choices[0].message?.content?.trim();
        if (!message) throw new Error('Empty response from OpenAI');
        this.logger('Successfully generated commit message via OpenAI', 'debug');
        return { success: true, message, tokensUsed: data.usage?.total_tokens, truncated: wasTruncated };
    }

    private async callAnthropic(prompt: string, settings: LLMSettings, wasTruncated: boolean): Promise<GenerateMessageResponse> {
        const payload = {
            model: settings.model,
            max_tokens: Math.min(150, settings.maxTokens), // Max response tokens
            temperature: settings.temperature,
            messages: [{ role: 'user', content: prompt }]
        };
        this.logger(`Calling Anthropic API. Model: ${settings.model}, Max Response Tokens: ${payload.max_tokens}`, 'debug');
        const response = await fetch(this.ANTHROPIC_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ status: response.status, message: response.statusText }));
            throw new Error(this.parseAnthropicError(response.status, errorData));
        }
        const data = await response.json();
        if (!data.content || data.content.length === 0) throw new Error('No response generated from Anthropic');
        const message = data.content[0]?.text?.trim();
        if (!message) throw new Error('Empty response from Anthropic');
        this.logger('Successfully generated commit message via Anthropic', 'debug');
        return { success: true, message, tokensUsed: data.usage?.input_tokens + data.usage?.output_tokens, truncated: wasTruncated };
    }

    private async callGemini(prompt: string, settings: LLMSettings, wasTruncated: boolean): Promise<GenerateMessageResponse> {
        const apiUrl = `${this.GEMINI_API_BASE_URL}/${settings.model}:generateContent?key=${settings.apiKey}`;
        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: settings.temperature,
                maxOutputTokens: Math.min(150, settings.maxTokens), // Max response tokens
            }
        };
        this.logger(`Calling Gemini API. Model: ${settings.model}, Max Response Tokens: ${payload.generationConfig.maxOutputTokens}`, 'debug');
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ status: response.status, message: response.statusText }));
            throw new Error(this.parseGeminiError(response.status, errorData));
        }
        const data = await response.json();
        if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content?.parts[0]?.text) {
            this.logger(`Invalid response structure from Gemini: ${JSON.stringify(data).substring(0,200)}`, 'error');
            throw new Error('No response or invalid format generated from Gemini');
        }
        const message = data.candidates[0].content.parts[0].text.trim();
        if (!message) throw new Error('Empty response from Gemini');
        this.logger('Successfully generated commit message via Gemini', 'debug');
        // Gemini API for generateContent doesn't directly return token usage in the same way.
        // It can be fetched via countTokens API separately if needed. For now, undefined.
        return { success: true, message, tokensUsed: undefined, truncated: wasTruncated };
    }

    private async callOpenRouter(prompt: string, settings: LLMSettings, wasTruncated: boolean): Promise<GenerateMessageResponse> {
        const payload = {
            model: settings.model, // OpenRouter model string e.g., "openai/gpt-3.5-turbo"
            messages: [{ role: 'user', content: prompt }],
            temperature: settings.temperature,
            max_tokens: Math.min(150, settings.maxTokens), // Max response tokens
        };
        this.logger(`Calling OpenRouter API. Model: ${settings.model}, Max Response Tokens: ${payload.max_tokens}`, 'debug');
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.apiKey}`,
            'X-Title': 'LLM-Committer', // Recommended by OpenRouter for identifying your app
        };
        if (settings.openRouterRefererUrl) {
            headers['HTTP-Referer'] = settings.openRouterRefererUrl; // Recommended by OpenRouter
        }
        const response = await fetch(this.OPENROUTER_API_URL, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ status: response.status, message: response.statusText }));
            // OpenRouter often mirrors OpenAI's error structure
            throw new Error(this.parseOpenAIError(response.status, errorData));
        }
        const data = await response.json();
        if (!data.choices || data.choices.length === 0 || !data.choices[0].message?.content) {
            throw new Error('No response or invalid format generated from OpenRouter');
        }
        const message = data.choices[0].message.content.trim();
        if (!message) throw new Error('Empty response from OpenRouter');
        this.logger('Successfully generated commit message via OpenRouter', 'debug');
        return { success: true, message, tokensUsed: data.usage?.total_tokens, truncated: wasTruncated };
    }

    private parseAnthropicError(status: number, errorData: any): string {
        const errorMessage = errorData?.error?.message || errorData?.message || 'Unknown Anthropic error';
        this.logger(`Anthropic API Error - Status: ${status}, Data: ${JSON.stringify(errorData)}`, 'debug');
        switch (status) {
            case 401: return `Invalid API key. Please check your Anthropic API key in settings. (${errorMessage})`;
            case 403: return `Forbidden. Your Anthropic API key might not have the right permissions or access level. (${errorMessage})`;
            case 429: return `Rate limit exceeded for Anthropic. Please try again in a moment. (${errorMessage})`;
            case 400: return errorMessage.toLowerCase().includes('maximum context length') || errorMessage.toLowerCase().includes('too long') ? `Request too large for Anthropic model. (${errorMessage})` : `Bad request to Anthropic: ${errorMessage}`;
            case 500: case 502: case 503: return `Anthropic service temporarily unavailable. (${errorMessage})`;
            default: return `Anthropic API error (${status}): ${errorMessage}`;
        }
    }

    private parseOpenAIError(status: number, errorData: any): string {
        const errorMessage = errorData?.error?.message || errorData?.message || 'Unknown OpenAI/OpenRouter error';
        this.logger(`OpenAI/OpenRouter API Error - Status: ${status}, Data: ${JSON.stringify(errorData)}`, 'debug');
        switch (status) {
            case 401: return `Invalid API key. Please check your API key in settings. (${errorMessage})`;
            case 403: return `Forbidden. Your API key might not have the right permissions or access level. (${errorMessage})`;
            case 429: return `Rate limit exceeded or quota reached. Please check your account status or try again later. (${errorMessage})`;
            case 400: return errorMessage.toLowerCase().includes('maximum context length') || errorMessage.toLowerCase().includes('context_length_exceeded') ? `Request too large for the model. (${errorMessage})` : `Bad request: ${errorMessage}`;
            case 500: case 502: case 503: return `AI Provider service temporarily unavailable. (${errorMessage})`;
            default: return `AI Provider API error (${status}): ${errorMessage}`;
        }
    }

    private parseGeminiError(status: number, errorData: any): string {
        const errorMessage = errorData?.error?.message || errorData?.message || 'Unknown Gemini error';
         this.logger(`Gemini API Error - Status: ${status}, Data: ${JSON.stringify(errorData)}`, 'debug');
        switch (status) {
            case 400:
                if (errorMessage.toLowerCase().includes('api key not valid')) return `Invalid API key for Gemini. (${errorMessage})`;
                if (errorMessage.toLowerCase().includes('user location is not supported')) return `User location not supported for Gemini API. (${errorMessage})`;
                if (errorMessage.toLowerCase().includes('resource_exhausted') || errorMessage.toLowerCase().includes('context length')) return `Request too large or resource exhausted for Gemini. (${errorMessage})`;
                return `Bad request to Gemini: ${errorMessage}`;
            case 403: return `Forbidden. Your Gemini API key might not have the right permissions or is disabled. (${errorMessage})`;
            case 429: return `Rate limit exceeded for Gemini. (${errorMessage})`;
            case 500: case 503: return `Gemini service temporarily unavailable. (${errorMessage})`;
            default: return `Gemini API error (${status}): ${errorMessage}`;
        }
    }

    private estimateTokens(text: string, maxTokensInSettings: number): TokenInfo {
        // A common rough estimate: 1 token ~ 4 chars in English.
        // This is a very rough heuristic and actual tokenization varies by model.
        const estimatedPromptTokens = Math.ceil(text.length / 3.5); // Adjusted for a bit more conservativeness
        // Reserve some tokens for the model's response (e.g., 150-300 tokens) and a safety margin.
        const reservedForResponseAndSafety = 300;
        const effectiveMaxPromptTokens = maxTokensInSettings - reservedForResponseAndSafety;

        return {
            estimated: estimatedPromptTokens,
            limit: effectiveMaxPromptTokens, // This is the limit for the prompt itself
            withinLimit: estimatedPromptTokens <= effectiveMaxPromptTokens,
            truncationSuggested: estimatedPromptTokens > effectiveMaxPromptTokens
        };
    }

    private truncateRequest(request: GenerateMessageRequest): GenerateMessageRequest {
        this.logger(`Attempting to truncate request file diffs. Max length per file: ${this.MAX_DIFF_LENGTH_PER_FILE_FOR_LLM} chars.`, 'debug');
        const truncatedDiffs = request.fileDiffs.map(diff => {
            if (diff.content.length > this.MAX_DIFF_LENGTH_PER_FILE_FOR_LLM) {
                this.logger(`Truncating diff for file: ${diff.filePath}. Original length: ${diff.content.length}`, 'debug');
                return {
                    ...diff,
                    content: diff.content.substring(0, this.MAX_DIFF_LENGTH_PER_FILE_FOR_LLM) + '\n... (diff content truncated by LLMService due to length)'
                };
            }
            return diff;
        });
        return { ...request, fileDiffs: truncatedDiffs };
    }

    public async testConnection(): Promise<{ success: boolean; error?: string }> {
        try {
            const settings = await this.configService.getLLMSettings();
            if (!settings.apiKey) return { success: false, error: 'No API key configured for the selected provider.' };

            const providerName = settings.provider.charAt(0).toUpperCase() + settings.provider.slice(1);
            const testMethodName = `test${providerName}Connection` as keyof this;

            if (typeof this[testMethodName] === 'function') {
                this.logger(`Testing connection for provider: ${providerName}`, 'debug');
                return await (this[testMethodName] as (s: LLMSettings) => Promise<{ success: boolean; error?: string }>)(settings);
            } else {
                this.logger(`Connection test not implemented for provider: ${settings.provider}`, 'warning');
                return { success: false, error: `Connection test not implemented for provider: ${settings.provider}` };
            }
        } catch (error) {
            const errorMessage = (error as Error).message;
            this.logger(`Connection test failed: ${errorMessage}`, 'error');
            return { success: false, error: `Connection failed: ${errorMessage}` };
        }
    }

    private async testOpenaiConnection(settings: LLMSettings): Promise<{ success: boolean; error?: string }> {
        const testPayload = { model: settings.model.split('/')[1] || settings.model, messages: [{ role: 'user', content: 'Test connection. Respond with "OK".' }], max_tokens: 10, temperature: 0 };
        if (settings.model.startsWith("openrouter/")) testPayload.model = settings.model; // OpenRouter uses full path

        const url = settings.provider === 'openrouter' ? this.OPENROUTER_API_URL : this.OPENAI_API_URL;
        const headers: HeadersInit = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}`};
        if (settings.provider === 'openrouter') {
             headers['X-Title'] = 'LLM-Committer (Test)';
             if(settings.openRouterRefererUrl) headers['HTTP-Referer'] = settings.openRouterRefererUrl;
        }

        this.logger(`Testing OpenAI/OpenRouter with URL: ${url}, Model: ${testPayload.model}`, 'debug');
        const response = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(testPayload) });
        if (response.ok) {
            const data = await response.json().catch(()=> ({})); // Ignore parse error on empty OK
            this.logger(`${settings.provider} API connection test successful. Response (partial): ${JSON.stringify(data).substring(0,100)}`, 'debug');
            return { success: true };
        }
        const errorData = await response.json().catch(() => ({ status: response.status, message: response.statusText }));
        return { success: false, error: this.parseOpenAIError(response.status, errorData) };
    }

    private async testAnthropicConnection(settings: LLMSettings): Promise<{ success: boolean; error?: string }> {
        const testPayload = { model: settings.model, max_tokens: 10, messages: [{ role: 'user', content: 'Test connection. Respond with "OK".' }] };
        this.logger(`Testing Anthropic with Model: ${testPayload.model}`, 'debug');
        const response = await fetch(this.ANTHROPIC_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(testPayload)
        });
        if (response.ok) {
            const data = await response.json().catch(()=> ({}));
            this.logger(`Anthropic API connection test successful. Response (partial): ${JSON.stringify(data).substring(0,100)}`, 'debug');
            return { success: true };
        }
        const errorData = await response.json().catch(() => ({ status: response.status, message: response.statusText }));
        return { success: false, error: this.parseAnthropicError(response.status, errorData) };
    }

    private async testGeminiConnection(settings: LLMSettings): Promise<{ success: boolean; error?: string }> {
        const apiUrl = `${this.GEMINI_API_BASE_URL}/${settings.model}:generateContent?key=${settings.apiKey}`;
        const testPayload = { contents: [{ parts: [{ text: "Test connection. Respond with 'OK'." }] }], generationConfig: { maxOutputTokens: 10, temperature: 0 } };
        this.logger(`Testing Gemini with Model: ${settings.model}`, 'debug');
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload)
        });
        if (response.ok) {
            const data = await response.json();
            if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
                this.logger(`Gemini API connection test successful. Response (partial): ${JSON.stringify(data).substring(0,100)}`, 'debug');
                return { success: true };
            }
            this.logger(`Gemini test call succeeded but response format was unexpected: ${JSON.stringify(data).substring(0,200)}`, 'warning');
            return { success: false, error: 'Gemini test call succeeded but response format was unexpected.' };
        }
        const errorData = await response.json().catch(() => ({ status: response.status, message: response.statusText }));
        return { success: false, error: this.parseGeminiError(response.status, errorData) };
    }

    private async testOpenrouterConnection(settings: LLMSettings): Promise<{ success: boolean; error?: string }> {
        // This method now just calls testOpenaiConnection with OpenRouter specifics if needed,
        // but testOpenaiConnection already handles OpenRouter distinction by checking settings.provider
        return this.testOpenaiConnection(settings);
    }


    public getAvailableModels(provider: LLMProvider): string[] {
        switch (provider) {
            case 'openai': return ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];
            case 'anthropic': return ['claude-3-5-sonnet-20240620', 'claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'];
            case 'gemini': return ['gemini-1.5-flash-latest', 'gemini-1.5-pro-latest', 'gemini-pro'];
            case 'openrouter': return [
                'openrouter/auto', // Special value for OpenRouter's model routing
                'google/gemini-flash-1.5', 'google/gemini-pro-1.5',
                'openai/gpt-4o-mini', 'openai/gpt-4o', 'openai/gpt-4-turbo',
                'anthropic/claude-3.5-sonnet', 'anthropic/claude-3-opus', 'anthropic/claude-3-sonnet', 'anthropic/claude-3-haiku',
                'mistralai/mistral-large', 'mistralai/mistral-medium', 'mistralai/mistral-small', 'mistralai/mistral-7b-instruct',
                'meta-llama/llama-3-70b-instruct','meta-llama/llama-3-8b-instruct',
                // Add more popular or useful models from OpenRouter's list
            ];
            default: return [];
        }
    }
}