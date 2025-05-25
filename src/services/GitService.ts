// src/services/GitService.ts - Phase 5+6: Enhanced with Diff Retrieval
import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as util from 'util';

const execAsync = util.promisify(exec);

export interface FileDiff {
    filePath: string;
    content: string;
    changeType: 'modified' | 'added' | 'deleted' | 'renamed';
}

export class GitService {
    private async getWorkspaceRoot(): Promise<string | undefined> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const folderPath = workspaceFolders[0].uri.fsPath;
            // Optional: Check if it's a git repository
            try {
                await execAsync('git rev-parse --is-inside-work-tree', { cwd: folderPath });
                return folderPath;
            } catch (error) {
                console.warn(`[GitService] Folder ${folderPath} is not a Git repository or git is not found.`);
                return undefined;
            }
        }
        return undefined;
    }

    public async getChangedFiles(): Promise<string[]> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                // vscode.window.showErrorMessage('LLM Committer: No folder open in the workspace.');
            } else {
                // vscode.window.showErrorMessage('LLM Committer: Could not find a Git repository in the primary open folder.');
            }
            return [];
        }

        try {
            const { stdout, stderr } = await execAsync('git status --porcelain=v1 -uall', { cwd: workspaceRoot });
            if (stderr) {
                console.error(`[GitService] stderr from git status: ${stderr}`);
            }
            if (!stdout) return [];

            const files = stdout
                .split('\n')
                .filter(line => line.trim() !== '')
                .map(line => {
                    // Status can be complex e.g. 'R  from -> to', ' M '
                    // We need to parse this carefully.
                    // For simplicity now, taking the part after status codes.
                    // A more robust parser would handle renames (R), copies (C), etc.
                    // Example ' M path/file.txt' -> 'path/file.txt'
                    // Example '?? path/new.txt' -> 'path/new.txt'
                    // Example 'R  old.txt -> new.txt' -> 'new.txt' (or both, depending on need)
                    const lineParts = line.trim().split(/\s+/);
                    if (lineParts[0] === 'R' && lineParts.length > 3) { // Handle rename
                        return lineParts.slice(3).join(' '); // path after '->'
                    }
                    return lineParts.slice(1).join(' '); // General case
                }).filter(Boolean); // remove any empty strings if parsing fails

            console.log('[GitService] Changed files:', files);
            return files;

        } catch (error: any) {
            console.error('[GitService] Error getting changed files:', error);
            vscode.window.showErrorMessage(`Error getting Git status: ${error.message}`);
            return [];
        }
    }

    // Phase 5+6: Get file diff content for LLM processing
    public async getFileDiff(filePath: string): Promise<FileDiff> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace/Git repository found');
        }

        try {
            console.log(`[GitService] Getting diff for: ${filePath}`);
            
            // First, check if file is new (untracked)
            const { stdout: statusOutput } = await execAsync(
                `git status --porcelain=v1 -- "${filePath.replace(/"/g, '\\"')}"`, 
                { cwd: workspaceRoot }
            );

            let changeType: FileDiff['changeType'] = 'modified';
            let diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`;

            if (statusOutput.trim()) {
                const statusCode = statusOutput.trim().substring(0, 2);
                if (statusCode.includes('??')) {
                    changeType = 'added';
                    // For new files, show the entire content
                    diffCommand = `git diff --no-index /dev/null "${filePath.replace(/"/g, '\\"')}"`;
                } else if (statusCode.includes('D')) {
                    changeType = 'deleted';
                } else if (statusCode.includes('R')) {
                    changeType = 'renamed';
                } else {
                    changeType = 'modified';
                }
            }

            // Get the diff content
            const { stdout: diffOutput, stderr } = await execAsync(diffCommand, { 
                cwd: workspaceRoot,
                maxBuffer: 1024 * 1024 // 1MB buffer for large diffs
            });

            if (stderr && !stderr.includes('warning:')) {
                console.warn(`[GitService] stderr from git diff for "${filePath}": ${stderr}`);
            }

            // Clean up the diff output for LLM consumption
            const cleanedDiff = this.cleanDiffForLLM(diffOutput, filePath, changeType);

            return {
                filePath,
                content: cleanedDiff,
                changeType
            };

        } catch (error: any) {
            console.error(`[GitService] Error getting diff for "${filePath}":`, error);
            
            // Fallback: try to get a simpler diff
            try {
                const { stdout: simpleDiff } = await execAsync(
                    `git diff -- "${filePath.replace(/"/g, '\\"')}"`, 
                    { cwd: workspaceRoot }
                );
                
                return {
                    filePath,
                    content: simpleDiff || `Unable to retrieve diff for ${filePath}`,
                    changeType: 'modified'
                };
            } catch (fallbackError) {
                return {
                    filePath,
                    content: `Error retrieving diff for ${filePath}: ${error.message}`,
                    changeType: 'modified'
                };
            }
        }
    }

    // Phase 5+6: Get multiple file diffs efficiently
    public async getFileDiffs(filePaths: string[]): Promise<FileDiff[]> {
        const diffs: FileDiff[] = [];
        
        for (const filePath of filePaths) {
            try {
                const diff = await this.getFileDiff(filePath);
                diffs.push(diff);
            } catch (error) {
                console.error(`[GitService] Failed to get diff for ${filePath}:`, error);
                // Include a placeholder diff so the user knows there was an issue
                diffs.push({
                    filePath,
                    content: `Error: Could not retrieve diff for ${filePath}`,
                    changeType: 'modified'
                });
            }
        }
        
        return diffs;
    }

    private cleanDiffForLLM(rawDiff: string, filePath: string, changeType: FileDiff['changeType']): string {
        if (!rawDiff.trim()) {
            return `File ${filePath} (${changeType}) - No diff content available`;
        }

        // Remove git-specific headers that aren't useful for LLM
        const lines = rawDiff.split('\n');
        const cleanLines: string[] = [];
        
        let inHeader = true;
        for (const line of lines) {
            // Skip git diff headers but keep file path info
            if (inHeader) {
                if (line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---')) {
                    if (line.startsWith('@@')) {
                        inHeader = false;
                        // Include context line for readability
                        cleanLines.push(line);
                    }
                    // Skip other header lines
                    continue;
                }
                if (line.startsWith('diff --git') || 
                    line.startsWith('index ') || 
                    line.startsWith('new file mode') ||
                    line.startsWith('deleted file mode')) {
                    continue;
                }
            }
            
            // Include the actual diff content
            cleanLines.push(line);
        }

        let result = cleanLines.join('\n').trim();
        
        // If the diff is very long, truncate it but keep context
        const maxLength = 1500; // Reasonable length for LLM processing
        if (result.length > maxLength) {
            const truncated = result.substring(0, maxLength);
            const lastNewline = truncated.lastIndexOf('\n');
            result = (lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated) + 
                     '\n... (diff truncated for brevity)';
        }

        // Add context about the change type
        const prefix = `Change type: ${changeType}\n\n`;
        
        return prefix + (result || `File ${filePath} - Unable to retrieve meaningful diff content`);
    }

    public async revertFile(filePath: string): Promise<void> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('LLM Committer: No workspace/folder open to revert file.');
            throw new Error('No workspace/folder open to revert file.');
        }

        // Ensure filePath is relative to workspaceRoot or correctly handled by git checkout
        // Typically, paths from `git status` are relative to the repo root.
        try {
            console.log(`[GitService] Attempting to revert file: "${filePath}" in ${workspaceRoot}`);
            // Quote the filePath to handle spaces and special characters
            const command = `git checkout -- "${filePath.replace(/"/g, '\\"')}"`; // Basic escaping for quotes
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceRoot });

            if (stderr && !stderr.includes('Your branch is up to date with')) { // Ignore some common non-error stderr
                // git checkout -- can produce stderr for legitimate reasons (e.g. file didn't change)
                // but also for errors. A more robust check might be needed based on git's exit codes.
                console.warn(`[GitService] stderr from git checkout for "${filePath}": ${stderr}`);
            }
            if (stdout) {
                 console.log(`[GitService] stdout from git checkout for "${filePath}": ${stdout}`);
            }
            console.log(`[GitService] File "${filePath}" revert command executed.`);
            // vscode.window.showInformationMessage(`Changes to "${path.basename(filePath)}" reverted.`); // Moved to extension.ts for better UI control

        } catch (error: any) {
            console.error(`[GitService] Error reverting file "${filePath}":`, error);
            // vscode.window.showErrorMessage(`Error reverting ${path.basename(filePath)}: ${error.message}`); // Moved to extension.ts
            throw error; // Re-throw to be caught by the caller in extension.ts
        }
    }

    // Future methods for Phase 7: stageFiles, commit, etc.
    public async stageFiles(filePaths: string[]): Promise<void> {
        // Placeholder for Phase 7
        console.log('[GitService] stageFiles - to be implemented in Phase 7');
    }

    public async commit(message: string): Promise<void> {
        // Placeholder for Phase 7
        console.log('[GitService] commit - to be implemented in Phase 7');
    }
}