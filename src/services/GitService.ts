// src/services/GitService.ts
import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = util.promisify(exec);

export interface FileDiff {
    filePath: string;
    content: string;
    changeType: 'modified' | 'added' | 'deleted' | 'renamed';
}

// Define a type for the logger function
type LoggerFunction = (
    message: string,
    type?: 'info' | 'error' | 'warning' | 'debug',
    showPopup?: boolean
) => void;

export class GitService {
    private logger: LoggerFunction;

    constructor(logger: LoggerFunction) {
        this.logger = logger;
    }

    private async getWorkspaceRoot(): Promise<string | undefined> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const folderPath = workspaceFolders[0].uri.fsPath;
            try {
                const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: folderPath });
                return stdout.trim();
            } catch (error) {
                this.logger(`Folder ${folderPath} is not a Git repository or git is not found. Error: ${error}`, 'warning');
                return undefined;
            }
        }
        return undefined;
    }

    public async getChangedFiles(): Promise<string[]> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            return [];
        }

        try {
            const { stdout, stderr } = await execAsync('git status --porcelain=v1 -uall', { cwd: workspaceRoot });
            if (stderr) {
                this.logger(`stderr from git status: ${stderr}`, 'warning');
            }
            if (!stdout) return [];

            const files = stdout
                .split('\n')
                .filter(line => line.trim() !== '')
                .map(line => {
                    const filePathRaw = line.substring(3);
                    if (filePathRaw.startsWith('"') && filePathRaw.endsWith('"')) {
                        return filePathRaw.substring(1, filePathRaw.length - 1);
                    }
                    if (line.startsWith('R ') && filePathRaw.includes(' -> ')) {
                        return filePathRaw.split(' -> ')[1];
                    }
                    return filePathRaw;
                }).filter(Boolean);

            this.logger(`Found ${files.length} changed files.`, 'debug');
            return files;

        } catch (error: any) {
            this.logger(`Error getting changed files: ${error.message}`, 'error');
            // User feedback (popup) is handled by the caller in extension.ts
            return [];
        }
    }

    public async getFileDiff(filePath: string): Promise<FileDiff> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace/Git repository found');
        }

        const absoluteFilePath = path.join(workspaceRoot, filePath);
        this.logger(`Getting diff for: ${filePath} (abs: ${absoluteFilePath})`, 'debug');

        try {
            const { stdout: statusOutput } = await execAsync(
                `git status --porcelain=v1 -- "${filePath.replace(/"/g, '\\"')}"`,
                { cwd: workspaceRoot }
            );

            let changeType: FileDiff['changeType'] = 'modified';
            let diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`; // Default to diff against HEAD

            if (statusOutput.trim()) {
                const statusCode = statusOutput.trim().substring(0, 2);
                console.log(`[GitService] Status code for ${filePath}: "${statusCode}"`);
                
                if (statusCode.startsWith('??')) { // Untracked file
                    changeType = 'added';
                    // For untracked files, diff against /dev/null to get full content
                    diffCommand = `git diff --no-index --no-ext-diff /dev/null "${filePath.replace(/"/g, '\\"')}"`;
                } else if (statusCode.startsWith('A ')) { // Added to index (staged)
                     changeType = 'added';
                     // Diff for newly added and staged file (content vs empty)
                     diffCommand = `git diff --staged -- "${filePath.replace(/"/g, '\\"')}"`;
                } else if (statusCode.startsWith('D')) { // Deleted from working tree (may or may not be staged for deletion)
                    changeType = 'deleted';
                     // Diff for deleted file (content vs HEAD)
                    diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`;
                } else if (statusCode.startsWith('R')) { // Renamed
                    changeType = 'renamed';
                    // Diff for renamed file, usually comparing new path content to old path content in HEAD
                    diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`;
                } else { // M, AM, MM etc. (Modified)
                    changeType = 'modified';
                     // Default: show full uncommitted change (working tree vs HEAD)
                     diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`;
                     // Optionally, distinguish between staged and unstaged modifications:
                     // if (statusOutput.trim().charAt(0) !== ' ') { // First char is index status (staged change)
                     //    diffCommand = `git diff --staged -- "${filePath.replace(/"/g, '\\"')}"`;
                     // } else { // First char is ' ', second is working tree status (unstaged change)
                     //    diffCommand = `git diff -- "${filePath.replace(/"/g, '\\"')}"`; // Working tree vs Index
                     // }
                }
            }

            const { stdout: diffOutput, stderr } = await execAsync(diffCommand, {
                cwd: workspaceRoot,
                maxBuffer: 1024 * 1024 * 5 // Increased buffer to 5MB
            });

            if (stderr && !stderr.includes('warning:')) { // Ignore common git warnings
                this.logger(`stderr from git diff for "${filePath}": ${stderr}`, 'warning');
            }

            const cleanedDiff = this.cleanDiffForLLM(diffOutput, filePath, changeType);
            return { filePath, content: cleanedDiff, changeType };

        } catch (error: any) {
            this.logger(`Error getting diff for "${filePath}": ${error.message}`, 'error');
            // Fallback for cases where the primary diff logic fails (e.g., complex states)
            try {
                this.logger(`Attempting fallback diff for "${filePath}" (git diff -- path)`, 'debug');
                const { stdout: simpleDiff } = await execAsync(
                    `git diff -- "${filePath.replace(/"/g, '\\"')}"`, // Diff working tree vs index
                    { cwd: workspaceRoot, maxBuffer: 1024 * 1024 * 5 }
                );
                const fallbackChangeType = (await this.determineChangeTypeSimple(filePath, workspaceRoot)) || 'modified';
                return {
                    filePath,
                    content: this.cleanDiffForLLM(simpleDiff, filePath, fallbackChangeType) || `Unable to retrieve diff for ${filePath}`,
                    changeType: fallbackChangeType
                };
            } catch (fallbackError: any) {
                this.logger(`Fallback diff also failed for "${filePath}": ${fallbackError.message}`, 'error');
                return {
                    filePath,
                    content: `New file ${filePath} - File not found on disk`,
                    changeType
                };
            }
        }
    }

    // Helper for fallback diff change type
    private async determineChangeTypeSimple(filePath: string, workspaceRoot: string): Promise<FileDiff['changeType'] | null> {
        try {
            const { stdout: statusOutput } = await execAsync(
                `git status --porcelain=v1 -- "${filePath.replace(/"/g, '\\"')}"`,
                { cwd: workspaceRoot }
            );
            if (statusOutput.trim()) {
                const statusCode = statusOutput.trim().substring(0, 2);
                if (statusCode.startsWith('??')) return 'added';
                if (statusCode.startsWith('A ')) return 'added';
                if (statusCode.startsWith('D')) return 'deleted';
                if (statusCode.startsWith('R')) return 'renamed';
                if (statusCode.startsWith('M') || statusOutput.trim().charAt(1) === 'M') return 'modified';
            }
        } catch (e) {
            this.logger(`Could not determine change type simply for ${filePath}: ${(e as Error).message}`, 'debug');
        }
        return null;
    }


    public async getFileDiffs(filePaths: string[]): Promise<FileDiff[]> {
        const diffs: FileDiff[] = [];
        for (const filePath of filePaths) {
            try {
                const diff = await this.getFileDiff(filePath);
                diffs.push(diff);
            } catch (error) {
                this.logger(`Failed to get diff for ${filePath} during getFileDiffs: ${error}`, 'error');
                diffs.push({
                    filePath,
                    content: `Error: Could not retrieve diff for ${filePath}`,
                    changeType: 'modified' // Or 'unknown'
                });
            }
        }
        return diffs;
    }

    private cleanDiffForLLM(rawDiff: string, filePath: string, changeType: FileDiff['changeType']): string {
        if (!rawDiff.trim()) {
            if (changeType === 'added') return `File ${filePath} (added) - Content of new file:\n(Content not displayed if file is binary or very large in this view; LLM should receive actual content diff for new text files)`;
            if (changeType === 'deleted') return `File ${filePath} (deleted) - Content of deleted file:\n(Content not displayed if file was binary or very large in this view)`;
            return `File ${filePath} (${changeType}) - No textual diff content available (e.g. binary file, mode change only, or no changes vs comparison point).`;
        }

        const lines = rawDiff.split('\n');
        const cleanLines: string[] = [];
        let inHeader = true;
        
        for (const line of lines) {
            if (inHeader) {
                if (line.startsWith('diff --git')) continue;
                if (line.startsWith('index ')) continue;
                if (line.startsWith('--- a/')) continue;
                if (line.startsWith('+++ b/')) continue;
                if (line.startsWith('new file mode')) continue;
                if (line.startsWith('deleted file mode')) continue;
                if (line.startsWith('similarity index')) continue;
                if (line.startsWith('rename from')) continue;
                if (line.startsWith('rename to')) continue;
                if (line.startsWith('binary files')) { // Handle binary files
                    cleanLines.push(line); // Keep the "binary files differ" line
                    // Optionally add more info:
                    // cleanLines.push(`Binary file ${filePath} differs.`);
                    break; // No further textual diff for binary files
                }
                if (line.startsWith('@@')) {
                    inHeader = false;
                }
            }
            // Always push line if not in header or if it's the @@ line (or if it's content after header for non-textual info)
            if (!inHeader || line.startsWith('@@') || (cleanLines.length > 0 && cleanLines[cleanLines.length -1].startsWith('binary files'))) {
                 cleanLines.push(line);
            }
        }

        let result = cleanLines.join('\n').trim();
        const maxLength = 15000; // Max length for a single diff string for the LLM prompt
        if (result.length > maxLength) {
            const truncated = result.substring(0, maxLength);
            const lastNewline = truncated.lastIndexOf('\n');
            result = (lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated) +
                     '\n... (diff truncated by GitService due to length)';
            this.logger(`Diff for ${filePath} truncated to ${maxLength} chars.`, 'debug');
        }
        // Ensure a meaningful header for the LLM
        return `Change type: ${changeType}\nFile: ${filePath}\n---\n${result || `No textual changes for ${filePath} after cleaning.`}\n---`;
    }

    public async revertFile(filePath: string): Promise<void> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace/folder open to revert file.');
        }
        this.logger(`Attempting to revert file: "${filePath}" in ${workspaceRoot}`, 'debug');
        try {
            const command = `git checkout -- "${filePath.replace(/"/g, '\\"')}"`;
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceRoot });

            if (stderr && !stderr.includes('Your branch is up to date with')) {
                this.logger(`stderr from git checkout for "${filePath}": ${stderr}`, 'warning');
            }
            if (stdout) {
                 this.logger(`stdout from git checkout for "${filePath}": ${stdout}`, 'debug');
            }
            this.logger(`File "${filePath}" revert command executed.`, 'debug');
        } catch (error: any) {
            this.logger(`Error reverting file "${filePath}": ${error.message}`, 'error');
            throw error;
        }
    }

    public async stageFiles(filePaths: string[]): Promise<void> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace/Git repository found to stage files.');
        }
        if (!filePaths || filePaths.length === 0) {
            this.logger('stageFiles called with no files.', 'warning');
            return;
        }
        const quotedFilePaths = filePaths.map(fp => `"${fp.replace(/"/g, '\\"')}"`).join(' ');
        this.logger(`Staging files: ${filePaths.join(', ')}`, 'debug');
        try {
            const command = `git add -- ${quotedFilePaths}`;
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceRoot });
            if (stderr) this.logger(`stderr from git add: ${stderr}`, 'warning');
            if (stdout) this.logger(`stdout from git add: ${stdout}`, 'debug');
            this.logger(`Files staged successfully: ${filePaths.length}`, 'debug');
        } catch (error: any) {
            this.logger(`Error staging files ${filePaths.join(', ')}: ${error.message}`, 'error');
            throw new Error(`Failed to stage files: ${error.message || String(error)}. Check file paths and Git status.`);
        }
    }

    public async commit(message: string): Promise<void> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) throw new Error('No workspace/Git repository found to commit.');
        if (!message || !message.trim()) throw new Error('Commit message cannot be empty.');

        this.logger(`Committing with message: "${message.substring(0, 50)}..."`, 'debug');
        try {
            const escapedMessage = message.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
            const command = `git commit -m "${escapedMessage}"`;
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceRoot });

            if (stderr && !stderr.includes("branch is ahead of") && !stderr.includes("nothing to commit, working tree clean") && !stderr.includes("Commits on this branch are protected")) {
                if (stderr.includes("nothing to commit")) {
                     this.logger(`'git commit' reported nothing to commit. Message: "${message.substring(0,50)}..."`, 'warning');
                     throw new Error(`Nothing to commit. Ensure files were staged correctly.`);
                }
                this.logger(`stderr from git commit: ${stderr}`, 'warning');
            }
            if (stdout) {
                this.logger(`stdout from git commit: ${stdout}`, 'debug');
                 if (stdout.includes("nothing to commit")) {
                    this.logger(`'git commit' (stdout) reported nothing to commit. Message: "${message.substring(0,50)}..."`, 'warning');
                    throw new Error(`Nothing to commit. Ensure files were staged correctly.`);
                }
            }
            this.logger(`Commit successful: "${message.substring(0, 50)}..."`, 'debug');
        } catch (error: any) {
            this.logger(`Error committing: ${error.message}`, 'error');
             if (error.message && error.message.toLowerCase().includes('nothing to commit')) {
                throw new Error(`Nothing to commit. Files might not have been staged properly or were already committed.`);
            }
            throw new Error(`Failed to commit: ${error.message || String(error)}`);
        }
    }
}