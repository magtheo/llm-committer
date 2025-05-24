// src/services/GitService.ts
import * as vscode from 'vscode';
import { exec } from 'child_process'; // For running shell commands
import * as util from 'util';

const execAsync = util.promisify(exec);

export class GitService {
    private getWorkspaceRoot(): string | undefined {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return workspaceFolders[0].uri.fsPath;
        }
        return undefined;
    }

    public async getChangedFiles(): Promise<string[]> {
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace/folder open.');
            return [];
        }

        try {
            // -uall shows untracked files properly
            // --porcelain=v1 gives a stable, easy-to-parse output
            const { stdout, stderr } = await execAsync('git status --porcelain=v1 -uall', { cwd: workspaceRoot });

            if (stderr) {
                console.error(`[GitService] stderr from git status: ${stderr}`);
                // Decide if stderr always means an error or just warnings
                // For now, let's proceed if stdout has content
            }

            if (!stdout) {
                return []; // No changes
            }

            const files = stdout
                .split('\n')
                .filter(line => line.trim() !== '')
                .map(line => {
                    // Example line: " M src/extension.ts" or "?? newfile.txt"
                    // We just need the filename part
                    return line.substring(3).trim(); // Skip status codes (e.g., ' M ', '?? ')
                });

            console.log('[GitService] Changed files:', files);
            return files;

        } catch (error: any) {
            console.error('[GitService] Error getting changed files:', error);
            vscode.window.showErrorMessage(`Error getting Git status: ${error.message}`);
            return [];
        }
    }

    // Future methods: getFileDiff, revertFileChanges, stageFiles, commit, etc.
}