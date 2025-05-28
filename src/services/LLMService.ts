// src/services/LLMService.ts
import { ConfigurationService, LLMSettings, LLMProvider } from './ConfigurationService'; // Use LLMSettings directly

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

export class LLMService {
    private configService: ConfigurationService;
    private readonly OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
    private readonly ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
    private readonly GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
    private readonly OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
    private readonly MAX_DIFF_LENGTH = 2000;

    constructor(configService: ConfigurationService) {
        this.configService = configService;
    }

    public async generateCommitMessage(request: GenerateMessageRequest): Promise<GenerateMessageResponse> {
        try {
            console.log('[LLMService] Starting commit message generation');
            
            const settings = await this.configService.getLLMSettings();
            
            if (!settings.apiKey.trim()) {
                return {
                    success: false,
                    error: 'API key not configured. Please set it up in settings for the selected provider.'
                };
            }

            const prompt = this.buildPrompt(request, settings.instructions);
            const tokenInfo = this.estimateTokens(prompt, settings.maxTokens);
            
            if (!tokenInfo.withinLimit) {
                console.warn(`[LLMService] Token limit exceeded: ${tokenInfo.estimated}/${tokenInfo.limit}`);
                const truncatedRequest = this.truncateRequest(request);
                const truncatedPrompt = this.buildPrompt(truncatedRequest, settings.instructions);
                const truncatedTokenInfo = this.estimateTokens(truncatedPrompt, settings.maxTokens);
                
                if (!truncatedTokenInfo.withinLimit) {
                    return {
                        success: false,
                        error: `Request too large (${tokenInfo.estimated} tokens). Please reduce context or select fewer files.`
                    };
                }
                
                console.log('[LLMService] Using truncated request due to token limits');
                return this.routeApiCall(truncatedPrompt, settings, true);
            }

            return this.routeApiCall(prompt, settings, false);

        } catch (error) {
            console.error('[LLMService] Error generating commit message:', error);
            return {
                success: false,
                error: `Failed to generate commit message: ${(error as Error).message}`
            };
        }
    }

    private routeApiCall(prompt: string, settings: LLMSettings, wasTruncated: boolean): Promise<GenerateMessageResponse> {
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
                console.error(`[LLMService] Unknown provider: ${settings.provider}`);
                return Promise.resolve({
                    success: false,
                    error: `Unknown provider: ${settings.provider}`
                });
        }
    }

    private buildPrompt(request: GenerateMessageRequest, instructions: string): string {
        const parts = [instructions, ''];
        if (request.generalContext.trim()) {
            parts.push(`General Project Context: ${request.generalContext.trim()}`, '');
        }
        if (request.groupContext.trim()) {
            parts.push(`Specific Context for This Change: ${request.groupContext.trim()}`, '');
        }
        if (request.fileDiffs.length > 0) {
            parts.push('Files and Changes:', '');
            request.fileDiffs.forEach(diff => {
                parts.push(`--- File: ${diff.filePath} ---`, diff.content, '');
            });
        }
        parts.push('Based on the above context and changes, generate a single, concise Git commit message:');
        return parts.join('\n');
    }

    private async callOpenAI(prompt: string, settings: LLMSettings, wasTruncated: boolean): Promise<GenerateMessageResponse> {
        const payload = {
            model: settings.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: Math.min(150, settings.maxTokens),
            temperature: settings.temperature,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        };
        console.log(`[LLMService] Calling OpenAI API with model: ${settings.model}`);
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
        console.log('[LLMService] Successfully generated commit message via OpenAI');
        return { success: true, message, tokensUsed: data.usage?.total_tokens, truncated: wasTruncated };
    }

    private async callAnthropic(prompt: string, settings: LLMSettings, wasTruncated: boolean): Promise<GenerateMessageResponse> {
        const payload = {
            model: settings.model,
            max_tokens: Math.min(150, settings.maxTokens),
            temperature: settings.temperature,
            messages: [{ role: 'user', content: prompt }]
        };
        console.log(`[LLMService] Calling Anthropic API with model: ${settings.model}`);
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
        console.log('[LLMService] Successfully generated commit message via Anthropic');
        return { success: true, message, tokensUsed: data.usage?.input_tokens + data.usage?.output_tokens, truncated: wasTruncated };
    }

    private async callGemini(prompt: string, settings: LLMSettings, wasTruncated: boolean): Promise<GenerateMessageResponse> {
        const apiUrl = `${this.GEMINI_API_BASE_URL}/${settings.model}:generateContent?key=${settings.apiKey}`;
        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: settings.temperature,
                maxOutputTokens: Math.min(150, settings.maxTokens),
            }
        };
        console.log(`[LLMService] Calling Gemini API with model: ${settings.model}`);
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
            console.error("[LLMService] Invalid response structure from Gemini:", data);
            throw new Error('No response or invalid format generated from Gemini');
        }
        const message = data.candidates[0].content.parts[0].text.trim();
        if (!message) throw new Error('Empty response from Gemini');
        console.log('[LLMService] Successfully generated commit message via Gemini');
        return { success: true, message, tokensUsed: undefined, truncated: wasTruncated };
    }

    private async callOpenRouter(prompt: string, settings: LLMSettings, wasTruncated: boolean): Promise<GenerateMessageResponse> {
        const payload = {
            model: settings.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: settings.temperature,
            max_tokens: Math.min(150, settings.maxTokens),
        };
        console.log(`[LLMService] Calling OpenRouter API with model: ${settings.model}`);
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.apiKey}`,
            'X-Title': 'LLM-Committer',
        };
        if (settings.openRouterRefererUrl) {
            headers['HTTP-Referer'] = settings.openRouterRefererUrl;
        }
        const response = await fetch(this.OPENROUTER_API_URL, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(this.parseOpenAIError(response.status, errorData));
        }
        const data = await response.json();
        if (!data.choices || data.choices.length === 0 || !data.choices[0].message?.content) {
            throw new Error('No response or invalid format generated from OpenRouter');
        }
        const message = data.choices[0].message.content.trim();
        if (!message) throw new Error('Empty response from OpenRouter');
        console.log('[LLMService] Successfully generated commit message via OpenRouter');
        return { success: true, message, tokensUsed: data.usage?.total_tokens, truncated: wasTruncated };
    }

    private parseAnthropicError(status: number, errorData: any): string {
        const errorMessage = errorData.error?.message || 'Unknown error';
        switch (status) {
            case 401: return 'Invalid API key. Please check your Anthropic API key in settings.';
            case 429: return 'Rate limit exceeded. Please try again in a moment.';
            case 400: return errorMessage.includes('maximum context length') || errorMessage.includes('too long') ? 'Request too large.' : `Bad request: ${errorMessage}`;
            case 500: case 502: case 503: return 'Anthropic service temporarily unavailable.';
            default: return `API error (${status}): ${errorMessage}`;
        }
    }

    private parseOpenAIError(status: number, errorData: any): string {
        const errorMessage = errorData.error?.message || 'Unknown error';
        switch (status) {
            case 401: return 'Invalid API key. Please check your OpenAI API key in settings.';
            case 429: return 'Rate limit exceeded. Please try again in a moment.';
            case 400: return errorMessage.includes('maximum context length') ? 'Request too large.' : `Bad request: ${errorMessage}`;
            case 500: case 502: case 503: return 'OpenAI service temporarily unavailable.';
            default: return `API error (${status}): ${errorMessage}`;
        }
    }

    private parseGeminiError(status: number, errorData: any): string {
        const errorMessage = errorData.error?.message || errorData.message || 'Unknown error';
        switch (status) {
            case 400:
                if (errorMessage.toLowerCase().includes('api key not valid')) return 'Invalid API key for Gemini.';
                if (errorMessage.toLowerCase().includes('user location is not supported')) return 'User location not supported for Gemini API.';
                return `Bad request to Gemini: ${errorMessage}`;
            case 429: return 'Rate limit exceeded for Gemini.';
            case 500: case 503: return 'Gemini service temporarily unavailable.';
            default: return `Gemini API error (${status}): ${errorMessage}`;
        }
    }

    private estimateTokens(text: string, maxTokens: number): TokenInfo {
        const estimated = Math.ceil(text.length / 4);
        const safeLimit = Math.floor(maxTokens * 0.8);
        return { estimated, limit: maxTokens, withinLimit: estimated <= safeLimit, truncationSuggested: estimated > safeLimit };
    }

    private truncateRequest(request: GenerateMessageRequest): GenerateMessageRequest {
        const truncatedDiffs = request.fileDiffs.map(diff => ({
            filePath: diff.filePath,
            content: diff.content.length > this.MAX_DIFF_LENGTH 
                ? diff.content.substring(0, this.MAX_DIFF_LENGTH) + '\n... (truncated)'
                : diff.content
        }));
        return { ...request, fileDiffs: truncatedDiffs };
    }

    public async testConnection(): Promise<{ success: boolean; error?: string }> {
        try {
            const settings = await this.configService.getLLMSettings();
            if (!settings.apiKey) return { success: false, error: 'No API key configured' };
            
            const providerName = settings.provider.charAt(0).toUpperCase() + settings.provider.slice(1);
            const testMethodName = `test${providerName}Connection` as keyof this; // Cast to keyof this

            if (typeof this[testMethodName] === 'function') {
                 // Type assertion to call the method
                return await (this[testMethodName] as (s: LLMSettings) => Promise<{ success: boolean; error?: string }>)(settings);
            } else {
                return { success: false, error: `Connection test not implemented for provider: ${settings.provider}` };
            }
        } catch (error) {
            console.error('[LLMService] Connection test failed:', error);
            return { success: false, error: `Connection failed: ${(error as Error).message}` };
        }
    }

    private async testOpenaiConnection(settings: LLMSettings): Promise<{ success: boolean; error?: string }> {
        const testPayload = { model: settings.model, messages: [{ role: 'user', content: 'Test connection. Respond with "OK".' }], max_tokens: 10, temperature: 0 };
        const response = await fetch(this.OPENAI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
            body: JSON.stringify(testPayload)
        });
        if (response.ok) {
            console.log('[LLMService] OpenAI API connection test successful');
            return { success: true };
        }
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: this.parseOpenAIError(response.status, errorData) };
    }

    private async testAnthropicConnection(settings: LLMSettings): Promise<{ success: boolean; error?: string }> {
        const testPayload = { model: settings.model, max_tokens: 10, messages: [{ role: 'user', content: 'Test connection. Respond with "OK".' }] };
        const response = await fetch(this.ANTHROPIC_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(testPayload)
        });
        if (response.ok) {
            console.log('[LLMService] Anthropic API connection test successful');
            return { success: true };
        }
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: this.parseAnthropicError(response.status, errorData) };
    }

    private async testGeminiConnection(settings: LLMSettings): Promise<{ success: boolean; error?: string }> {
        const apiUrl = `${this.GEMINI_API_BASE_URL}/${settings.model}:generateContent?key=${settings.apiKey}`;
        const testPayload = { contents: [{ parts: [{ text: "Test connection. Respond with 'OK'." }] }], generationConfig: { maxOutputTokens: 10, temperature: 0 } };
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload)
        });
        if (response.ok) {
            const data = await response.json();
            if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
                console.log('[LLMService] Gemini API connection test successful');
                return { success: true };
            }
            return { success: false, error: 'Gemini test call succeeded but response format was unexpected.' };
        }
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: this.parseGeminiError(response.status, errorData) };
    }

    private async testOpenrouterConnection(settings: LLMSettings): Promise<{ success: boolean; error?: string }> {
        const testModel = settings.model.includes('/') ? settings.model : `openai/${settings.model}`; 
        const testPayload = { model: testModel, messages: [{ role: 'user', content: 'Test connection. Respond with "OK".' }], max_tokens: 10, temperature: 0 };
        const headers: HeadersInit = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}`, 'X-Title': 'LLM-Committer (Test)'};
        if (settings.openRouterRefererUrl) {
            headers['HTTP-Referer'] = settings.openRouterRefererUrl;
        }
        const response = await fetch(this.OPENROUTER_API_URL, { method: 'POST', headers, body: JSON.stringify(testPayload) });
        if (response.ok) {
            console.log('[LLMService] OpenRouter API connection test successful');
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
                'openrouter/auto', 'google/gemini-flash-1.5', 'google/gemini-pro-1.5',
                'openai/gpt-4o-mini', 'openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 
                'anthropic/claude-3-haiku', 'mistralai/mistral-7b-instruct', 'meta-llama/llama-3-8b-instruct',
            ];
            default: return [];
        }
    }
}