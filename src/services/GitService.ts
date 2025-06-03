// src/services/GitService.ts
import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs'; // Ensure fs is imported if used, though not directly in this version

const execAsync = util.promisify(exec);

export interface FileDiff {
    filePath: string;
    content: string;
    changeType: FileDiffChangeType; // Use the defined type alias
}

// Define type alias for changeType to ensure consistency
export type FileDiffChangeType = 'modified' | 'added' | 'deleted' | 'renamed';


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
                const errorInst = error as Error;
                this.logger(`Folder ${folderPath} is not a Git repository or git is not found. Error: ${errorInst.message}`, 'warning');
                console.warn(`[GitService] Folder ${folderPath} not a Git repo:`, errorInst);
                return undefined;
            }
        }
        return undefined;
    }

    public async getChangedFiles(): Promise<string[]> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            this.logger('No workspace/Git repository root found for getChangedFiles.', 'debug');
            return [];
        }

        try {
            const { stdout, stderr } = await execAsync('git status --porcelain=v1 -uall', { cwd: workspaceRoot });
            if (stderr) {
                this.logger(`stderr from git status: ${stderr}`, 'warning');
                console.warn(`[GitService] stderr from git status: ${stderr}`);
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
            const errorInst = error as Error;
            this.logger(`Error getting changed files: ${errorInst.message}`, 'error', true);
            console.error('[GitService] Error getting changed files:', errorInst);
            return [];
        }
    }

    public async getFileDiff(filePath: string): Promise<FileDiff> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            this.logger('No workspace/Git repository found for getFileDiff.', 'error');
            throw new Error('No workspace/Git repository found');
        }

        const absoluteFilePath = path.join(workspaceRoot, filePath);
        this.logger(`Getting diff for: ${filePath} (absolute: ${absoluteFilePath})`, 'debug');
        let determinedChangeType: FileDiffChangeType = 'modified'; // Default

        try {
            const { stdout: statusOutput } = await execAsync(
                `git status --porcelain=v1 -- "${filePath.replace(/"/g, '\\"')}"`,
                { cwd: workspaceRoot }
            );

            let diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`;

            if (statusOutput.trim()) {
                const statusCode = statusOutput.trim().substring(0, 2);
                this.logger(`[GitService] Status code for ${filePath}: "${statusCode}"`, 'debug');
                
                if (statusCode.startsWith('??')) { determinedChangeType = 'added'; diffCommand = `git diff --no-index --no-ext-diff /dev/null "${filePath.replace(/"/g, '\\"')}"`; }
                else if (statusCode.startsWith('A ')) { determinedChangeType = 'added'; diffCommand = `git diff --staged -- "${filePath.replace(/"/g, '\\"')}"`; }
                else if (statusCode.startsWith('D')) { determinedChangeType = 'deleted'; diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`; }
                else if (statusCode.startsWith('R')) { determinedChangeType = 'renamed'; diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`; }
                else { determinedChangeType = 'modified'; diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`; }
            }
            this.logger(`Using diff command for ${filePath}: ${diffCommand}`, 'debug');

            const { stdout: diffOutput, stderr } = await execAsync(diffCommand, {
                cwd: workspaceRoot,
                maxBuffer: 1024 * 1024 * 5
            });

            if (stderr && !stderr.includes('warning:')) {
                this.logger(`stderr from git diff for "${filePath}": ${stderr}`, 'warning');
                console.warn(`[GitService] stderr from git diff for "${filePath}": ${stderr}`);
            }

            const cleanedDiff = this.cleanDiffForLLM(diffOutput, filePath, determinedChangeType);
            return { filePath, content: cleanedDiff, changeType: determinedChangeType };

        } catch (error: any) {
            const errorInst = error as Error;
            this.logger(`Error getting diff for "${filePath}": ${errorInst.message}`, 'error');
            console.error(`[GitService] Error getting diff for "${filePath}":`, errorInst);
            try {
                this.logger(`Attempting fallback diff for "${filePath}" (git diff -- path)`, 'debug');
                const { stdout: simpleDiff } = await execAsync(
                    `git diff -- "${filePath.replace(/"/g, '\\"')}"`,
                    { cwd: workspaceRoot, maxBuffer: 1024 * 1024 * 5 }
                );
                const fallbackChangeType = (await this.determineChangeTypeSimple(filePath, workspaceRoot)) || 'modified';
                return {
                    filePath,
                    content: this.cleanDiffForLLM(simpleDiff, filePath, fallbackChangeType) || `Unable to retrieve diff for ${filePath}`,
                    changeType: fallbackChangeType // Explicitly assign here
                };
            } catch (fallbackError: any) {
                const fallbackErrorInst = fallbackError as Error;
                this.logger(`Fallback diff also failed for "${filePath}": ${fallbackErrorInst.message}`, 'error');
                console.error(`[GitService] Fallback diff also failed for "${filePath}":`, fallbackErrorInst);
                // If even fallback fails, return with the initially determined or default changeType
                return {
                    filePath,
                    content: `Error retrieving diff for ${filePath}: ${errorInst.message}`, // Main error message
                    changeType: determinedChangeType // Use the determined type or default if determination failed early
                };
            }
        }
    }
    
    private async determineChangeTypeSimple(filePath: string, workspaceRoot: string): Promise<FileDiffChangeType | null> {
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
            const errorInst = e as Error;
            this.logger(`Could not determine change type simply for ${filePath}: ${errorInst.message}`, 'debug');
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
                const errorInst = error as Error;
                this.logger(`Failed to get diff for ${filePath} during getFileDiffs: ${errorInst.message}`, 'error');
                console.error(`[GitService] Failed to get diff for ${filePath} during getFileDiffs:`, errorInst);
                diffs.push({
                    filePath,
                    content: `Error: Could not retrieve diff for ${filePath}`,
                    changeType: 'modified' // Default changeType on error
                });
            }
        }
        return diffs;
    }

    private cleanDiffForLLM(rawDiff: string, filePath: string, changeType: FileDiffChangeType): string {
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
                if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- a/') || line.startsWith('+++ b/') ||
                    line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('similarity index') ||
                    line.startsWith('rename from') || line.startsWith('rename to')) continue;
                if (line.startsWith('binary files')) {
                    cleanLines.push(line);
                    break;
                }
                if (line.startsWith('@@')) inHeader = false;
            }
            if (!inHeader || line.startsWith('@@') || (cleanLines.length > 0 && cleanLines[cleanLines.length -1].startsWith('binary files'))) {
                 cleanLines.push(line);
            }
        }

        let result = cleanLines.join('\n').trim();
        const maxLength = 15000;
        if (result.length > maxLength) {
            const truncated = result.substring(0, maxLength);
            const lastNewline = truncated.lastIndexOf('\n');
            result = (lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated) +
                     '\n... (diff truncated by GitService due to length)';
            this.logger(`Diff for ${filePath} truncated to ${maxLength} chars.`, 'debug');
        }
        return `Change type: ${changeType}\nFile: ${filePath}\n---\n${result || `No textual changes for ${filePath} after cleaning.`}\n---`;
    }

    public async revertFile(filePath: string): Promise<void> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            this.logger('No workspace/folder open to revert file.', 'error', true);
            throw new Error('No workspace/folder open to revert file.');
        }
        this.logger(`Attempting to revert file: "${filePath}" in ${workspaceRoot}`, 'debug');
        try {
            const command = `git checkout -- "${filePath.replace(/"/g, '\\"')}"`;
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceRoot });

            if (stderr && !stderr.includes('Your branch is up to date with')) {
                this.logger(`stderr from git checkout for "${filePath}": ${stderr}`, 'warning');
                console.warn(`[GitService] stderr from git checkout for "${filePath}": ${stderr}`);
            }
            if (stdout) this.logger(`stdout from git checkout for "${filePath}": ${stdout}`, 'debug');
            this.logger(`File "${filePath}" revert command executed.`, 'debug');
        } catch (error: any) {
            const errorInst = error as Error;
            this.logger(`Error reverting file "${filePath}": ${errorInst.message}`, 'error', true);
            console.error(`[GitService] Error reverting file "${filePath}":`, errorInst);
            throw error;
        }
    }

    public async stageFiles(filePaths: string[]): Promise<void> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            this.logger('No workspace/Git repository found to stage files.', 'error');
            throw new Error('No workspace/Git repository found to stage files.');
        }
        if (!filePaths || filePaths.length === 0) {
            this.logger('stageFiles called with no files.', 'warning');
            return;
        }
        const quotedFilePaths = filePaths.map(fp => `"${fp.replace(/"/g, '\\"')}"`).join(' ');
        this.logger(`Staging ${filePaths.length} files: ${filePaths.join(', ')}`, 'debug');
        try {
            const command = `git add -- ${quotedFilePaths}`;
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceRoot });
            if (stderr) {
                this.logger(`stderr from git add: ${stderr}`, 'warning');
                console.warn(`[GitService] stderr from git add: ${stderr}`);
            }
            if (stdout) this.logger(`stdout from git add: ${stdout}`, 'debug');
            this.logger(`Successfully staged ${filePaths.length} files.`, 'debug');
        } catch (error: any) {
            const errorInst = error as Error;
            this.logger(`Error staging files ${filePaths.join(', ')}: ${errorInst.message}`, 'error');
            console.error(`[GitService] Error staging files ${filePaths.join(', ')}:`, errorInst);
            throw new Error(`Failed to stage files: ${errorInst.message}. Check file paths and Git status.`);
        }
    }

    public async commit(message: string): Promise<void> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            this.logger('No workspace/Git repository found to commit.', 'error');
            throw new Error('No workspace/Git repository found to commit.');
        }
        if (!message || !message.trim()) {
            this.logger('Commit message cannot be empty.', 'error');
            throw new Error('Commit message cannot be empty.');
        }
        this.logger(`Committing with message (first 50 chars): "${message.substring(0, 50)}..."`, 'debug');
        try {
            const escapedMessage = message.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
            const command = `git commit -m "${escapedMessage}"`;
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceRoot });

            if (stderr && !stderr.includes("branch is ahead of") && !stderr.includes("nothing to commit, working tree clean") && !stderr.includes("Commits on this branch are protected")) {
                if (stderr.includes("nothing to commit")) {
                     this.logger(`'git commit' reported nothing to commit. Message: "${message.substring(0,50)}..."`, 'warning');
                     console.warn(`[GitService] 'git commit' reported nothing to commit (stderr).`);
                     throw new Error(`Nothing to commit. Ensure files were staged correctly.`);
                }
                this.logger(`stderr from git commit: ${stderr}`, 'warning');
                console.warn(`[GitService] stderr from git commit: ${stderr}`);
            }
            if (stdout) {
                this.logger(`stdout from git commit: ${stdout}`, 'debug');
                 if (stdout.includes("nothing to commit")) {
                    this.logger(`'git commit' (stdout) reported nothing to commit. Message: "${message.substring(0,50)}..."`, 'warning');
                    console.warn(`[GitService] 'git commit' reported nothing to commit (stdout).`);
                    throw new Error(`Nothing to commit. Ensure files were staged correctly.`);
                }
            }
            this.logger(`Commit successful: "${message.substring(0, 50)}..."`, 'debug');
        } catch (error: any) {
            const errorInst = error as Error;
            this.logger(`Error committing: ${errorInst.message}`, 'error');
            console.error(`[GitService] Error committing:`, errorInst);
             if (errorInst.message.toLowerCase().includes('nothing to commit')) {
                throw new Error(`Nothing to commit. Files might not have been staged properly or were already committed.`);
            }
            throw new Error(`Failed to commit: ${errorInst.message}`);
        }
    }
}