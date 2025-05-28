// src/services/GitService.ts - Phase 5+6: Enhanced with Diff Retrieval
import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as util from 'util';
import * as path from 'path';

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
            try {
                // Check if it's a git repository root by looking for .git
                // A more robust check might be `git rev-parse --is-inside-work-tree`
                // but `git rev-parse --show-toplevel` is better to ensure we are at the root.
                const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: folderPath });
                // Ensure the returned toplevel is the same as our workspace folder.
                // This handles cases where a subfolder of a git repo is opened.
                // For simplicity, we'll assume workspaceFolder[0] is the repo root for now,
                // but `git status` paths are relative to repo root.
                // The `cwd` for execAsync should be the repo root.
                return stdout.trim();
            } catch (error) {
                console.warn(`[GitService] Folder ${folderPath} is not a Git repository or git is not found. Error: ${error}`);
                return undefined;
            }
        }
        return undefined;
    }

    public async getChangedFiles(): Promise<string[]> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            // No error message here; UI should handle "no repo" state based on empty list.
            return [];
        }

        try {
            // `git status --porcelain=v1 -uall` paths are relative to the repo root.
            const { stdout, stderr } = await execAsync('git status --porcelain=v1 -uall', { cwd: workspaceRoot });
            if (stderr) {
                console.error(`[GitService] stderr from git status: ${stderr}`);
                // Don't throw; some stderr might be warnings. If git command fails, it throws.
            }
            if (!stdout) return [];

            const files = stdout
                .split('\n')
                .filter(line => line.trim() !== '')
                .map(line => {
                    const filePathRaw = line.substring(3); // XY path
                    // Handle paths with spaces, potentially quoted
                    if (filePathRaw.startsWith('"') && filePathRaw.endsWith('"')) {
                        return filePathRaw.substring(1, filePathRaw.length - 1);
                    }
                    // Handle renamed files: R <old> -> <new>
                    if (line.startsWith('R ') && filePathRaw.includes(' -> ')) {
                        return filePathRaw.split(' -> ')[1];
                    }
                    return filePathRaw;
                }).filter(Boolean);

            console.log('[GitService] Changed files:', files);
            return files;

        } catch (error: any) {
            console.error('[GitService] Error getting changed files:', error);
            vscode.window.showErrorMessage(`Error getting Git status: ${error.message}`);
            return [];
        }
    }

    public async getFileDiff(filePath: string): Promise<FileDiff> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace/Git repository found');
        }

        // filePath from getChangedFiles is relative to repo root.
        const absoluteFilePath = path.join(workspaceRoot, filePath);

        try {
            console.log(`[GitService] Getting diff for: ${filePath} (abs: ${absoluteFilePath})`);
            
            const { stdout: statusOutput } = await execAsync(
                `git status --porcelain=v1 -- "${filePath.replace(/"/g, '\\"')}"`, 
                { cwd: workspaceRoot }
            );

            let changeType: FileDiff['changeType'] = 'modified';
            // For staged diff: `git diff --staged -- "${filePath}"`
            // For unstaged diff (working tree vs index): `git diff -- "${filePath}"`
            // For combined (working tree vs HEAD): `git diff HEAD -- "${filePath}"`
            // We typically want to show what *would be* committed if staged now, or what *is* staged.
            // For LLM, `git diff HEAD` is good for uncommitted changes.
            let diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`;

            if (statusOutput.trim()) {
                const statusCode = statusOutput.trim().substring(0, 2);
                if (statusCode.startsWith('??')) { // Untracked
                    changeType = 'added';
                    diffCommand = `git diff --no-index --no-ext-diff /dev/null "${filePath.replace(/"/g, '\\"')}"`;
                } else if (statusCode.startsWith('A ')) { // Added to index (staged)
                     changeType = 'added';
                     diffCommand = `git diff --staged -- "${filePath.replace(/"/g, '\\"')}"`;
                } else if (statusCode.startsWith('D')) { // Deleted
                    changeType = 'deleted';
                     // diff for deleted file (vs HEAD)
                    diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`;
                } else if (statusCode.startsWith('R')) {
                    changeType = 'renamed';
                    // For renames, diff might be against HEAD or staged
                    diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`;
                } else { // M, AM, MM etc.
                    changeType = 'modified';
                     // If file is staged (e.g. ' M'), show staged diff. Else working tree diff.
                    if (statusOutput.trim().charAt(0) !== ' ') { // First char is index status
                        diffCommand = `git diff --staged -- "${filePath.replace(/"/g, '\\"')}"`;
                    } else { // First char is ' ', second is working tree status
                         diffCommand = `git diff -- "${filePath.replace(/"/g, '\\"')}"`;
                    }
                     // Let's simplify and always use `git diff HEAD` for now to see full uncommitted change
                     diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`;

                }
            }

            const { stdout: diffOutput, stderr } = await execAsync(diffCommand, { 
                cwd: workspaceRoot,
                maxBuffer: 1024 * 1024 // 1MB buffer
            });

            if (stderr && !stderr.includes('warning:')) {
                console.warn(`[GitService] stderr from git diff for "${filePath}": ${stderr}`);
            }

            const cleanedDiff = this.cleanDiffForLLM(diffOutput, filePath, changeType);

            return {
                filePath,
                content: cleanedDiff,
                changeType
            };

        } catch (error: any) {
            console.error(`[GitService] Error getting diff for "${filePath}":`, error);
            // Try a simpler diff as fallback (e.g. if file is purely new and not yet handled above)
            try {
                const { stdout: simpleDiff } = await execAsync(
                    `git diff -- "${filePath.replace(/"/g, '\\"')}"`, 
                    { cwd: workspaceRoot }
                );
                return {
                    filePath,
                    content: simpleDiff || `Unable to retrieve diff for ${filePath}`,
                    changeType: 'modified' // Assume modified on fallback
                };
            } catch (fallbackError) {
                console.error(`[GitService] Fallback diff also failed for "${filePath}":`, fallbackError);
                return {
                    filePath,
                    content: `Error retrieving diff for ${filePath}: ${(error.message || String(error))}`,
                    changeType: 'modified' // Or 'unknown'
                };
            }
        }
    }


    public async getFileDiffs(filePaths: string[]): Promise<FileDiff[]> {
        // This can be optimized by calling `git diff HEAD -- path1 path2 ...` once
        // but parsing the multi-file diff output is more complex.
        // For now, individual calls are simpler to implement.
        const diffs: FileDiff[] = [];
        for (const filePath of filePaths) {
            try {
                const diff = await this.getFileDiff(filePath);
                diffs.push(diff);
            } catch (error) {
                console.error(`[GitService] Failed to get diff for ${filePath} during getFileDiffs:`, error);
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
            if (changeType === 'added') return `File ${filePath} (added) - Content of new file:\n(Content not included in this diff view; LLM will get full content for new files if logic is adjusted)`;
            return `File ${filePath} (${changeType}) - No textual diff content available (e.g. binary file or no changes vs HEAD).`;
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

                if (line.startsWith('@@')) {
                    inHeader = false;
                    // cleanLines.push(`--- File: ${filePath} ---`); // Add file marker if not already clear
                }
            }
            // Always push line if not in header or if it's the @@ line
            if (!inHeader || line.startsWith('@@')) {
                 cleanLines.push(line);
            }
        }

        let result = cleanLines.join('\n').trim();
        const maxLength = 15000; // Increased length for diffs, LLMService truncates further if needed for prompt
        if (result.length > maxLength) {
            const truncated = result.substring(0, maxLength);
            const lastNewline = truncated.lastIndexOf('\n');
            result = (lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated) +
                     '\n... (diff truncated by GitService for display/initial processing)';
        }

        return `Change type: ${changeType}\nFile: ${filePath}\n${result || `No textual changes for ${filePath}`}`;
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

    public async stageFiles(filePaths: string[]): Promise<void> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace/Git repository found to stage files.');
        }
        if (!filePaths || filePaths.length === 0) {
            console.warn('[GitService] stageFiles called with no files.');
            return; // Or throw error? For now, just return.
        }

        // Quote file paths to handle spaces and special characters
        const quotedFilePaths = filePaths.map(fp => `"${fp.replace(/"/g, '\\"')}"`).join(' ');

        try {
            console.log(`[GitService] Staging files: ${quotedFilePaths}`);
            const command = `git add -- ${quotedFilePaths}`; // -- ensures paths are not mistaken for options
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceRoot });

            if (stderr) {
                // `git add` can produce stderr for various reasons that aren't necessarily fatal errors
                // (e.g., pathspec did not match any files if a file was deleted externally after being listed)
                console.warn(`[GitService] stderr from git add: ${stderr}`);
            }
            if (stdout) {
                console.log(`[GitService] stdout from git add: ${stdout}`);
            }
            console.log(`[GitService] Files staged: ${filePaths.join(', ')}`);
        } catch (error: any) {
            console.error(`[GitService] Error staging files ${filePaths.join(', ')}:`, error);
            throw new Error(`Failed to stage files: ${error.message || String(error)}. Check file paths and Git status.`);
        }
    }

    public async commit(message: string): Promise<void> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace/Git repository found to commit.');
        }
        if (!message || !message.trim()) {
            throw new Error('Commit message cannot be empty.');
        }

        try {
            console.log(`[GitService] Committing with message: "${message}"`);
            // Use -F - to pass message via stdin to handle multi-line messages and special characters
            // Or escape the message properly for -m if it's simpler and generally single-line.
            // For multiline, using a temporary file or stdin is more robust.
            // Let's use `git commit -m "message"` for simplicity now, assuming messages are well-behaved.
            // A more robust way: `echo "${message.replace(/"/g, '\\"')}" | git commit -F -`
            
            const escapedMessage = message.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
            const command = `git commit -m "${escapedMessage}"`;
            
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceRoot });

            if (stderr && !stderr.includes("branch is ahead of") && !stderr.includes("nothing to commit, working tree clean")) {
                // "nothing to commit" can happen if staging failed silently or files were unstaged externally.
                // This should ideally be caught earlier.
                if (stderr.includes("nothing to commit")) {
                     console.warn(`[GitService] 'git commit' reported nothing to commit. Message: "${message}"`);
                     throw new Error(`Nothing to commit. Ensure files were staged correctly.`);
                }
                console.warn(`[GitService] stderr from git commit: ${stderr}`);
            }
            if (stdout) {
                console.log(`[GitService] stdout from git commit: ${stdout}`);
                 if (stdout.includes("nothing to commit")) { // Also check stdout
                    console.warn(`[GitService] 'git commit' (stdout) reported nothing to commit. Message: "${message}"`);
                    throw new Error(`Nothing to commit. Ensure files were staged correctly.`);
                }
            }
            console.log(`[GitService] Commit successful: "${message}"`);
        } catch (error: any) {
            console.error(`[GitService] Error committing:`, error);
             if (error.message && error.message.toLowerCase().includes('nothing to commit')) {
                throw new Error(`Nothing to commit. Files might not have been staged properly or were already committed.`);
            }
            throw new Error(`Failed to commit: ${error.message || String(error)}`);
        }
    }

}