// src/services/LLMService.ts - Phase 5+6: Complete LLM Integration
import { ConfigurationService } from './ConfigurationService';

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
    private readonly MAX_DIFF_LENGTH = 2000; // Characters per diff to prevent token overflow

    constructor(configService: ConfigurationService) {
        this.configService = configService;
    }

    public async generateCommitMessage(request: GenerateMessageRequest): Promise<GenerateMessageResponse> {
        try {
            console.log('[LLMService] Starting commit message generation');
            
            // Get LLM configuration
            const settings = await this.configService.getLLMSettings();
            
            if (!settings.apiKey) {
                return {
                    success: false,
                    error: 'API key not configured. Please set up your OpenAI API key in settings.'
                };
            }

            // Build the prompt
            const prompt = this.buildPrompt(request, settings.instructions);
            
            // Check token limits
            const tokenInfo = this.estimateTokens(prompt, settings.maxTokens);
            
            if (!tokenInfo.withinLimit) {
                console.warn(`[LLMService] Token limit exceeded: ${tokenInfo.estimated}/${tokenInfo.limit}`);
                
                // Try to truncate and retry
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
                if (settings.provider === 'anthropic') {
                    return await this.callAnthropic(truncatedPrompt, settings, true);
                } else {
                    return await this.callOpenAI(truncatedPrompt, settings, true);
                }
            }

            // Make the API call
            if (settings.provider === 'anthropic') {
                return await this.callAnthropic(prompt, settings, false);
            } else {
                return await this.callOpenAI(prompt, settings, false);
            }

        } catch (error) {
            console.error('[LLMService] Error generating commit message:', error);
            return {
                success: false,
                error: `Failed to generate commit message: ${(error as Error).message}`
            };
        }
    }

    private buildPrompt(request: GenerateMessageRequest, instructions: string): string {
        const parts = [
            instructions,
            ''
        ];

        if (request.generalContext.trim()) {
            parts.push(`General Project Context: ${request.generalContext.trim()}`);
            parts.push('');
        }

        if (request.groupContext.trim()) {
            parts.push(`Specific Context for This Change: ${request.groupContext.trim()}`);
            parts.push('');
        }

        if (request.fileDiffs.length > 0) {
            parts.push('Files and Changes:');
            parts.push('');
            
            request.fileDiffs.forEach(diff => {
                parts.push(`--- File: ${diff.filePath} ---`);
                parts.push(diff.content);
                parts.push('');
            });
        }

        parts.push('Based on the above context and changes, generate a single, concise Git commit message:');

        return parts.join('\n');
    }

    private async callOpenAI(prompt: string, settings: any, wasTruncated: boolean): Promise<GenerateMessageResponse> {
        const payload = {
            model: settings.model,
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: Math.min(150, settings.maxTokens), // Limit response length for commit messages
            temperature: settings.temperature,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        };

        console.log(`[LLMService] Calling OpenAI API with model: ${settings.model}`);

        const response = await fetch(this.OPENAI_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = this.parseOpenAIError(response.status, errorData);
            throw new Error(errorMessage);
        }

        const data = await response.json();
        
        if (!data.choices || data.choices.length === 0) {
            throw new Error('No response generated from OpenAI');
        }

        const message = data.choices[0].message?.content?.trim();
        if (!message) {
            throw new Error('Empty response from OpenAI');
        }

        console.log('[LLMService] Successfully generated commit message');

        return {
            success: true,
            message: message,
            tokensUsed: data.usage?.total_tokens,
            truncated: wasTruncated
        };
    }

    private async callAnthropic(prompt: string, settings: any, wasTruncated: boolean): Promise<GenerateMessageResponse> {
        const payload = {
            model: settings.model,
            max_tokens: Math.min(150, settings.maxTokens),
            temperature: settings.temperature,
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ]
        };

        console.log(`[LLMService] Calling Anthropic API with model: ${settings.model}`);

        const response = await fetch(this.ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': settings.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = this.parseAnthropicError(response.status, errorData);
            throw new Error(errorMessage);
        }

        const data = await response.json();
        
        if (!data.content || data.content.length === 0) {
            throw new Error('No response generated from Anthropic');
        }

        const message = data.content[0]?.text?.trim();
        if (!message) {
            throw new Error('Empty response from Anthropic');
        }

        console.log('[LLMService] Successfully generated commit message via Anthropic');

        return {
            success: true,
            message: message,
            tokensUsed: data.usage?.input_tokens + data.usage?.output_tokens,
            truncated: wasTruncated
        };
    }

    private parseAnthropicError(status: number, errorData: any): string {
        const errorMessage = errorData.error?.message || 'Unknown error';
        
        switch (status) {
            case 401:
                return 'Invalid API key. Please check your Anthropic API key in settings.';
            case 429:
                return 'Rate limit exceeded. Please try again in a moment.';
            case 400:
                if (errorMessage.includes('maximum context length') || errorMessage.includes('too long')) {
                    return 'Request too large. Please reduce context or select fewer files.';
                }
                return `Bad request: ${errorMessage}`;
            case 500:
            case 502:
            case 503:
                return 'Anthropic service temporarily unavailable. Please try again later.';
            default:
                return `API error (${status}): ${errorMessage}`;
        }
    }

    private parseOpenAIError(status: number, errorData: any): string {
        const errorMessage = errorData.error?.message || 'Unknown error';
        
        switch (status) {
            case 401:
                return 'Invalid API key. Please check your OpenAI API key in settings.';
            case 429:
                return 'Rate limit exceeded. Please try again in a moment.';
            case 400:
                if (errorMessage.includes('maximum context length')) {
                    return 'Request too large. Please reduce context or select fewer files.';
                }
                return `Bad request: ${errorMessage}`;
            case 500:
            case 502:
            case 503:
                return 'OpenAI service temporarily unavailable. Please try again later.';
            default:
                return `API error (${status}): ${errorMessage}`;
        }
    }

    private estimateTokens(text: string, maxTokens: number): TokenInfo {
        // Rough estimation: 1 token ≈ 4 characters for English text
        // This is approximate but good enough for our purposes
        const estimated = Math.ceil(text.length / 4);
        const safeLimit = Math.floor(maxTokens * 0.8); // Leave 20% buffer for response
        
        return {
            estimated,
            limit: maxTokens,
            withinLimit: estimated <= safeLimit,
            truncationSuggested: estimated > safeLimit
        };
    }

    private truncateRequest(request: GenerateMessageRequest): GenerateMessageRequest {
        const truncatedDiffs = request.fileDiffs.map(diff => ({
            filePath: diff.filePath,
            content: diff.content.length > this.MAX_DIFF_LENGTH 
                ? diff.content.substring(0, this.MAX_DIFF_LENGTH) + '\n... (truncated)'
                : diff.content
        }));

        return {
            ...request,
            fileDiffs: truncatedDiffs
        };
    }

    // Test API connection
    public async testConnection(): Promise<{ success: boolean; error?: string }> {
        try {
            const settings = await this.configService.getLLMSettings();
            
            if (!settings.apiKey) {
                return { success: false, error: 'No API key configured' };
            }

            if (settings.provider === 'anthropic') {
                return await this.testAnthropicConnection(settings);
            } else {
                return await this.testOpenAIConnection(settings);
            }

        } catch (error) {
            console.error('[LLMService] Connection test failed:', error);
            return { 
                success: false, 
                error: `Connection failed: ${(error as Error).message}` 
            };
        }
    }

    private async testOpenAIConnection(settings: any): Promise<{ success: boolean; error?: string }> {
        const testPayload = {
            model: settings.model,
            messages: [{ role: 'user', content: 'Test connection. Respond with "OK".' }],
            max_tokens: 10,
            temperature: 0
        };

        const response = await fetch(this.OPENAI_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify(testPayload)
        });

        if (response.ok) {
            console.log('[LLMService] OpenAI API connection test successful');
            return { success: true };
        } else {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = this.parseOpenAIError(response.status, errorData);
            return { success: false, error: errorMessage };
        }
    }

    private async testAnthropicConnection(settings: any): Promise<{ success: boolean; error?: string }> {
        const testPayload = {
            model: settings.model,
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Test connection. Respond with "OK".' }]
        };

        const response = await fetch(this.ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': settings.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(testPayload)
        });

        if (response.ok) {
            console.log('[LLMService] Anthropic API connection test successful');
            return { success: true };
        } else {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = this.parseAnthropicError(response.status, errorData);
            return { success: false, error: errorMessage };
        }
    }

    // Get available models (for future enhancement)
    public getAvailableModels(provider: 'openai' | 'anthropic'): string[] {
        if (provider === 'anthropic') {
            return [
                'claude-3-5-haiku-20241022',
                'claude-3-5-sonnet-20241022',
                'claude-3-haiku-20240307',
                'claude-3-sonnet-20240229',
                'claude-3-opus-20240229'
            ];
        } else {
            return [
                'gpt-4o-mini',
                'gpt-4o',
                'gpt-4-turbo',
                'gpt-4',
                'gpt-3.5-turbo'
            ];
        }
    }
}