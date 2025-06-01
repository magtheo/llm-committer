// src/services/GitService.ts - Enhanced with proper new file handling
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

export class GitService {
    private async getWorkspaceRoot(): Promise<string | undefined> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const folderPath = workspaceFolders[0].uri.fsPath;
            try {
                const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: folderPath });
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

        const absoluteFilePath = path.join(workspaceRoot, filePath);

        try {
            console.log(`[GitService] Getting diff for: ${filePath} (abs: ${absoluteFilePath})`);
            
            const { stdout: statusOutput } = await execAsync(
                `git status --porcelain=v1 -- "${filePath.replace(/"/g, '\\"')}"`, 
                { cwd: workspaceRoot }
            );

            let changeType: FileDiff['changeType'] = 'modified';
            let diffCommand = '';
            let isNewFile = false;

            if (statusOutput.trim()) {
                const statusCode = statusOutput.trim().substring(0, 2);
                console.log(`[GitService] Status code for ${filePath}: "${statusCode}"`);
                
                if (statusCode.startsWith('??')) { // Untracked file
                    changeType = 'added';
                    isNewFile = true;
                } else if (statusCode.includes('A')) { // Added to index (staged new file)
                    changeType = 'added';
                    isNewFile = true;
                } else if (statusCode.startsWith('D') || statusCode.includes('D')) { // Deleted
                    changeType = 'deleted';
                    diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`;
                } else if (statusCode.startsWith('R')) {
                    changeType = 'renamed';
                    diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`;
                } else { // M, AM, MM etc.
                    changeType = 'modified';
                    diffCommand = `git diff HEAD -- "${filePath.replace(/"/g, '\\"')}"`;
                }
            }

            // Handle new files specially
            if (isNewFile) {
                return this.handleNewFile(filePath, absoluteFilePath, changeType);
            }

            // Handle existing files with git diff
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
            
            // Try to handle as a new file if the regular diff failed
            if (fs.existsSync(absoluteFilePath)) {
                try {
                    return this.handleNewFile(filePath, absoluteFilePath, 'added');
                } catch (newFileError) {
                    console.error(`[GitService] Fallback new file handling also failed for "${filePath}":`, newFileError);
                }
            }
            
            return {
                filePath,
                content: `Error retrieving diff for ${filePath}: ${(error.message || String(error))}`,
                changeType: 'modified'
            };
        }
    }

    private async handleNewFile(filePath: string, absoluteFilePath: string, changeType: FileDiff['changeType']): Promise<FileDiff> {
        try {
            console.log(`[GitService] Handling new file: ${filePath}`);
            
            // Check if file exists
            if (!fs.existsSync(absoluteFilePath)) {
                return {
                    filePath,
                    content: `New file ${filePath} - File not found on disk`,
                    changeType
                };
            }

            // Read the file content
            const fileContent = fs.readFileSync(absoluteFilePath, 'utf8');
            
            // Format as a clear "new file" diff
            const formattedContent = this.formatNewFileContent(filePath, fileContent);
            
            return {
                filePath,
                content: formattedContent,
                changeType
            };

        } catch (error: any) {
            console.error(`[GitService] Error reading new file "${filePath}":`, error);
            return {
                filePath,
                content: `Error reading new file ${filePath}: ${error.message}`,
                changeType
            };
        }
    }

    private formatNewFileContent(filePath: string, content: string): string {
        const lines = content.split('\n');
        const maxLength = 15000; // Same limit as other diffs
        
        let formattedContent = `Change type: added\nFile: ${filePath}\n\n=== NEW FILE ===\n`;
        formattedContent += `This is a completely new file being added to the repository.\n\n`;
        formattedContent += `File content (${lines.length} lines):\n`;
        formattedContent += `--- ${filePath} (new file) ---\n`;
        
        // Add line numbers to make it clear this is new content
        const numberedLines = lines.map((line, index) => `+${(index + 1).toString().padStart(3, ' ')}: ${line}`);
        formattedContent += numberedLines.join('\n');
        
        // Truncate if too long
        if (formattedContent.length > maxLength) {
            const truncated = formattedContent.substring(0, maxLength);
            const lastNewline = truncated.lastIndexOf('\n');
            formattedContent = (lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated) +
                             '\n... (new file content truncated for LLM prompt)';
        }
        
        return formattedContent;
    }

    private cleanDiffForLLM(rawDiff: string, filePath: string, changeType: FileDiff['changeType']): string {
        if (!rawDiff.trim()) {
            if (changeType === 'added') {
                return `File ${filePath} (added) - Content of new file:\n(Content not included in this diff view; LLM will get full content for new files if logic is adjusted)`;
            }
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
                }
            }
            
            if (!inHeader || line.startsWith('@@')) {
                cleanLines.push(line);
            }
        }

        let result = cleanLines.join('\n').trim();
        const maxLength = 15000;
        
        if (result.length > maxLength) {
            const truncated = result.substring(0, maxLength);
            const lastNewline = truncated.lastIndexOf('\n');
            result = (lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated) +
                     '\n... (diff truncated by GitService for display/initial processing)';
        }

        return `Change type: ${changeType}\nFile: ${filePath}\n${result || `No textual changes for ${filePath}`}`;
    }

    public async getFileDiffs(filePaths: string[]): Promise<FileDiff[]> {
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
                    changeType: 'modified'
                });
            }
        }
        return diffs;
    }

    public async revertFile(filePath: string): Promise<void> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('LLM Committer: No workspace/folder open to revert file.');
            throw new Error('No workspace/folder open to revert file.');
        }

        try {
            console.log(`[GitService] Attempting to revert file: "${filePath}" in ${workspaceRoot}`);
            
            // Check if this is an untracked file
            const { stdout: statusOutput } = await execAsync(
                `git status --porcelain=v1 -- "${filePath.replace(/"/g, '\\"')}"`, 
                { cwd: workspaceRoot }
            );
            
            if (statusOutput.trim().startsWith('??')) {
                // Untracked file - just delete it
                const absolutePath = path.join(workspaceRoot, filePath);
                if (fs.existsSync(absolutePath)) {
                    fs.unlinkSync(absolutePath);
                    console.log(`[GitService] Deleted untracked file: "${filePath}"`);
                }
                return;
            }
            
            // For tracked files, use git checkout
            const command = `git checkout -- "${filePath.replace(/"/g, '\\"')}"`;
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceRoot });

            if (stderr && !stderr.includes('Your branch is up to date with')) {
                console.warn(`[GitService] stderr from git checkout for "${filePath}": ${stderr}`);
            }
            if (stdout) {
                console.log(`[GitService] stdout from git checkout for "${filePath}": ${stdout}`);
            }
            console.log(`[GitService] File "${filePath}" revert command executed.`);

        } catch (error: any) {
            console.error(`[GitService] Error reverting file "${filePath}":`, error);
            throw error;
        }
    }

    public async stageFiles(filePaths: string[]): Promise<void> {
        const workspaceRoot = await this.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace/Git repository found to stage files.');
        }
        if (!filePaths || filePaths.length === 0) {
            console.warn('[GitService] stageFiles called with no files.');
            return;
        }

        const quotedFilePaths = filePaths.map(fp => `"${fp.replace(/"/g, '\\"')}"`).join(' ');

        try {
            console.log(`[GitService] Staging files: ${quotedFilePaths}`);
            const command = `git add -- ${quotedFilePaths}`;
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceRoot });

            if (stderr) {
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
            
            const escapedMessage = message.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
            const command = `git commit -m "${escapedMessage}"`;
            
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceRoot });

            if (stderr && !stderr.includes("branch is ahead of") && !stderr.includes("nothing to commit, working tree clean")) {
                if (stderr.includes("nothing to commit")) {
                    console.warn(`[GitService] 'git commit' reported nothing to commit. Message: "${message}"`);
                    throw new Error(`Nothing to commit. Ensure files were staged correctly.`);
                }
                console.warn(`[GitService] stderr from git commit: ${stderr}`);
            }
            if (stdout) {
                console.log(`[GitService] stdout from git commit: ${stdout}`);
                if (stdout.includes("nothing to commit")) {
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