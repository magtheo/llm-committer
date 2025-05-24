// src/services/GitService.ts
import * as vscode from 'vscode';
import { exec } from 'child_process'; // For running shell commands
import * as util from 'util';

const execAsync = util.promisify(exec);

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

    // Future methods: getFileDiff, stageFiles, commit, etc.
}