// src/services/StateService.ts
import * as vscode from 'vscode';
import { LLMProvider } from './ConfigurationService';

export interface CurrentGroup {
    files: string[];
    specificContext: string;
    commitMessage?: string;
    isGenerating?: boolean; 
}

export interface StagedGroup {
    id: string; 
    files: string[];
    specificContext: string;
    commitMessage: string;
}

// Assuming AppState['settings'] will align with WebviewSettings from App.tsx for provider, model etc.
// For LLMProvider, ensure it's the same type from ConfigurationService if that's the source of truth.
export interface AppSettingsInState {
    hasApiKey: boolean;
    provider: LLMProvider; // From ConfigurationService
    model: string;
    maxTokens: number;
    temperature: number;
    instructionsLength: number;
    openRouterRefererUrl?: string; // Added this
}

export interface AppState {
    changedFiles: string[];
    currentGroup: CurrentGroup | null;
    currentView: 'fileselection' | 'group' | 'settings' | 'reviewStagedGroup';
    selectedFiles: string[];
    generalContext: string;
    settings: AppSettingsInState; // Use the refined interface
    stagedGroups: StagedGroup[];
    currentEditingStagedGroupId: string | null;
}

type LoggerFunction = (message: string, type?: 'info' | 'error' | 'warning' | 'debug', showPopup?: boolean) => void;

export class StateService {
    private context: vscode.ExtensionContext | undefined; 
    private logger: LoggerFunction;

    private _state: AppState = {
        changedFiles: [],
        currentGroup: null,
        currentView: 'fileselection',
        selectedFiles: [],
        generalContext: '',
        settings: {
            hasApiKey: false,
            provider: 'openai',
            model: 'gpt-4o-mini',
            maxTokens: 4000,
            temperature: 0.3,
            instructionsLength: 0,
            openRouterRefererUrl: 'http://localhost' // Default
        },
        stagedGroups: [],
        currentEditingStagedGroupId: null,
    };

    private _onStateChanged = new vscode.EventEmitter<AppState>();
    public readonly onStateChanged = this._onStateChanged.event;

    constructor(logger: LoggerFunction = console.log) {
        this.logger = logger;
    }

    public initialize(context: vscode.ExtensionContext): void {
        this.context = context;
        this.loadStagedGroups(); 
    }

    private generateGroupId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2);
    }

    public get state(): AppState {
        return { ...this._state }; 
    }

    public setChangedFiles(files: string[]): void {
        this.logger(`Setting ${files.length} changed files. Previous count: ${this._state.changedFiles.length}.`, 'debug');
        this._state.changedFiles = files;
        
        const originalSelectedCount = this._state.selectedFiles.length;
        this._state.selectedFiles = this._state.selectedFiles.filter(file => files.includes(file));
        if (this._state.selectedFiles.length !== originalSelectedCount) {
            this.logger(`Updated selected files based on new changed files list. ${originalSelectedCount - this._state.selectedFiles.length} files removed from selection.`, 'debug');
        }

        let stagedGroupsModified = false;
        const originalStagedGroupsCount = this._state.stagedGroups.length;
        this._state.stagedGroups = this._state.stagedGroups.map(group => {
            const originalFileCount = group.files.length;
            const updatedFiles = group.files.filter(sf => files.includes(sf));

            if (updatedFiles.length !== originalFileCount) {
                stagedGroupsModified = true;
                if (updatedFiles.length === 0) {
                    this.logger(`Staged group ${group.id} ("${group.commitMessage.substring(0,20)}...") became empty due to file changes and will be removed.`, 'warning');
                    return null; 
                }
                this.logger(`Files in staged group ${group.id} updated due to external changes. Old count: ${originalFileCount}, New count: ${updatedFiles.length}.`, 'debug');
                return { ...group, files: updatedFiles };
            }
            return group;
        }).filter(group => group !== null) as StagedGroup[];

        if (stagedGroupsModified || this._state.stagedGroups.length !== originalStagedGroupsCount) {
            this.logger('Persisting staged groups after file list update.', 'debug');
            this.persistStagedGroups();
        }

        this._onStateChanged.fire({ ...this._state });
    }

    public setSelectedFiles(files: string[]): void {
        this._state.selectedFiles = files;
        this.logger(`Selected files updated. Count: ${files.length}.`, 'debug');
        this._onStateChanged.fire({ ...this._state });
    }

    public toggleFileSelection(filePath: string): void {
        const index = this._state.selectedFiles.indexOf(filePath);
        if (index === -1) {
            this._state.selectedFiles.push(filePath);
            this.logger(`File selected: ${filePath}`, 'debug');
        } else {
            this._state.selectedFiles.splice(index, 1);
            this.logger(`File deselected: ${filePath}`, 'debug');
        }
        this._onStateChanged.fire({ ...this._state });
    }

    public startNewGroup(files: string[]): void {
        const filesAlreadyStaged = new Set(this._state.stagedGroups.flatMap(g => g.files));
        const filesForNewGroup = files.filter(f => !filesAlreadyStaged.has(f));

        if (filesForNewGroup.length === 0 && files.length > 0) {
            this.logger("Attempted to create group, but all selected files are already in other staged groups.", 'warning', true);
            vscode.window.showWarningMessage("All selected files are already in other staged groups.");
            return;
        }
        if (filesForNewGroup.length === 0) {
            this.logger("Attempted to create group with no available files.", 'warning', true);
            vscode.window.showWarningMessage("No files available for new group.");
            return;
        }

        this._state.currentGroup = {
            files: [...filesForNewGroup],
            specificContext: '',
            commitMessage: undefined,
            isGenerating: false
        };
        this._state.currentView = 'group';
        this._state.selectedFiles = []; 
        this.logger(`Started new group with ${filesForNewGroup.length} files. Navigating to 'group' view.`, 'debug');
        this._onStateChanged.fire({ ...this._state });
    }

    public clearCurrentGroup(): void {
        this._state.currentGroup = null;
        this._state.currentView = 'fileselection';
        this._state.currentEditingStagedGroupId = null; 
        this.logger('Current group cleared. Navigating to "fileselection" view.', 'debug');
        this._onStateChanged.fire({ ...this._state });
    }

    public updateCurrentGroupSpecificContext(context: string): void {
        if (this._state.currentGroup) {
            this._state.currentGroup.specificContext = context;
            this.logger('Current group specific context updated.', 'debug');
            this._onStateChanged.fire({ ...this._state });
        }
    }

    public updateCurrentGroupCommitMessage(message: string): void {
        if (this._state.currentGroup) {
            this._state.currentGroup.commitMessage = message;
            this.logger('Current group commit message updated.', 'debug');
            this._onStateChanged.fire({ ...this._state });
        }
    }

    public setCurrentView(view: AppState['currentView']): void {
        this._state.currentView = view;
        if (view !== 'reviewStagedGroup') {
            this._state.currentEditingStagedGroupId = null; 
        }
        this.logger(`Current view set to: ${view}.`, 'debug');
        this._onStateChanged.fire({ ...this._state });
    }

    public setGeneralContext(context: string): void {
        this._state.generalContext = context;
        this.logger('General context updated.', 'debug');
        this._onStateChanged.fire({ ...this._state });
    }

    public getGeneralContext(): string {
        return this._state.generalContext;
    }

    public setGeneratingMessage(isGenerating: boolean): void {
        if (this._state.currentGroup) {
            this._state.currentGroup.isGenerating = isGenerating;
            this.logger(`Current group 'isGenerating' flag set to: ${isGenerating}.`, 'debug');
            this._onStateChanged.fire({ ...this._state });
        }
    }

    public isGeneratingMessage(): boolean { // This might only be relevant for new groups now
        return this._state.currentGroup?.isGenerating || false;
    }

    public updateSettings(settings: Partial<AppSettingsInState>): void { // Use AppSettingsInState
        this._state.settings = { ...this._state.settings, ...settings };
        this.logger('Internal extension settings state updated.', 'debug');
        this._onStateChanged.fire({ ...this._state });
    }

    public getSettings(): AppSettingsInState { // Use AppSettingsInState
        return { ...this._state.settings };
    }

    public loadStagedGroups(): void {
        if (!this.context) {
            this.logger('Context not available for loading staged groups.', 'warning');
            return;
        }
        const persistedGroups = this.context.workspaceState.get<StagedGroup[]>('llmCommitter.stagedGroups');
        if (persistedGroups) {
            this._state.stagedGroups = persistedGroups;
            this.logger(`Loaded ${persistedGroups.length} staged groups from workspace state.`, 'debug');
        } else {
            this._state.stagedGroups = [];
            this.logger('No persisted staged groups found in workspace state.', 'debug');
        }
    }

    public persistStagedGroups(): void {
        if (!this.context) {
            this.logger('Context not available for persisting staged groups.', 'warning');
            return;
        }
        this.context.workspaceState.update('llmCommitter.stagedGroups', this._state.stagedGroups)
            .then(() => this.logger(`Persisted ${this._state.stagedGroups.length} staged groups to workspace state.`, 'debug'),
                  (err) => {
                      const errorMsg = err instanceof Error ? err.message : String(err);
                      console.error('[StateService] Error persisting staged groups:', errorMsg); // Keep for dev console
                      this.logger(`Error persisting staged groups: ${errorMsg}`, 'error');
                  });
    }

    public stageCurrentGroup(): boolean {
        if (!this._state.currentGroup || !this._state.currentGroup.commitMessage?.trim()) {
            this.logger('Attempted to stage group without current group or commit message.', 'warning', true);
            vscode.window.showErrorMessage("Cannot stage group: commit message is missing.");
            return false;
        }
        if (this._state.currentGroup.files.length === 0) {
            this.logger('Attempted to stage group with no files.', 'warning', true);
            vscode.window.showErrorMessage("Cannot stage group: no files in the group.");
            return false;
        }

        const newStagedGroup: StagedGroup = {
            id: this.generateGroupId(),
            files: [...this._state.currentGroup.files],
            specificContext: this._state.currentGroup.specificContext,
            commitMessage: this._state.currentGroup.commitMessage.trim(),
        };

        this._state.stagedGroups.push(newStagedGroup);
        this.persistStagedGroups();
        this.logger(`Group ${newStagedGroup.id} ("${newStagedGroup.commitMessage.substring(0,20)}...") staged.`, 'debug');
        this.clearCurrentGroup(); 
        return true;
    }

    public unstageGroup(groupId: string): void {
        const groupIndex = this._state.stagedGroups.findIndex(g => g.id === groupId);
        if (groupIndex > -1) {
            const unstagedGroup = this._state.stagedGroups.splice(groupIndex, 1)[0];
            this.persistStagedGroups();
            this.logger(`Group ${groupId} ("${unstagedGroup.commitMessage.substring(0,20)}...") unstaged.`, 'debug');

            if (this._state.currentEditingStagedGroupId === groupId) {
                this._state.currentEditingStagedGroupId = null;
                this._state.currentView = 'fileselection'; 
                this.logger('Currently reviewed group was unstaged, navigating to fileselection.', 'debug');
            }
            this._onStateChanged.fire({ ...this._state });
            vscode.window.showInformationMessage(`Group "${unstagedGroup.commitMessage.substring(0,20)}..." unstaged.`);
        } else {
            this.logger(`Attempted to unstage non-existent group: ${groupId}`, 'warning');
        }
    }
    
    public removeStagedGroupById(groupId: string): void {
        const initialLength = this._state.stagedGroups.length;
        this._state.stagedGroups = this._state.stagedGroups.filter(g => g.id !== groupId);
        if (this._state.stagedGroups.length < initialLength) {
            this.persistStagedGroups();
            this.logger(`Staged group ${groupId} removed (likely after commit).`, 'debug');
            this._onStateChanged.fire({ ...this._state });
        }
    }

    public updateStagedGroup(groupId: string, updates: Partial<Pick<StagedGroup, 'specificContext' | 'commitMessage' | 'files'>>): void {
        const groupIndex = this._state.stagedGroups.findIndex(g => g.id === groupId);
        if (groupIndex > -1) {
            const group = this._state.stagedGroups[groupIndex];
            if (updates.files && updates.files.length === 0) {
                this.logger("Attempt to update staged group to have zero files. This is not allowed; unstage instead.", 'warning', true);
                vscode.window.showWarningMessage("A staged group cannot have zero files. Unstage the group instead if you want to remove all files.");
                delete updates.files; 
            }

            this._state.stagedGroups[groupIndex] = { ...group, ...updates };
            this.persistStagedGroups();
            this.logger(`Staged group ${groupId} updated. Updates: ${JSON.stringify(Object.keys(updates))}`, 'debug');
            this._onStateChanged.fire({ ...this._state });
        } else {
            this.logger(`Attempted to update non-existent staged group: ${groupId}`, 'warning');
        }
    }

    public removeFileFromStagedGroup(groupId: string, filePathToRemove: string): void {
        const groupIndex = this._state.stagedGroups.findIndex(g => g.id === groupId);
        if (groupIndex > -1) {
            const group = this._state.stagedGroups[groupIndex];
            const updatedFiles = group.files.filter(f => f !== filePathToRemove);

            if (updatedFiles.length === 0) {
                this.logger(`Removing last file from staged group ${groupId}. Group will be unstaged.`, 'debug');
                this.unstageGroup(groupId); // This will fire state change and persist
                vscode.window.showInformationMessage(`Group "${group.commitMessage.substring(0,20)}..." became empty and was unstaged.`);
            } else if (updatedFiles.length < group.files.length) {
                this._state.stagedGroups[groupIndex] = { ...group, files: updatedFiles };
                this.persistStagedGroups();
                this.logger(`File ${filePathToRemove} removed from staged group ${groupId}.`, 'debug');
                this._onStateChanged.fire({ ...this._state });
            }
        } else {
            this.logger(`Attempted to remove file from non-existent staged group: ${groupId}`, 'warning');
        }
    }

    public setCurrentEditingStagedGroupId(groupId: string | null): void {
        this._state.currentEditingStagedGroupId = groupId;
        if (groupId) {
            this._state.currentView = 'reviewStagedGroup';
            this.logger(`Set current editing staged group ID to: ${groupId}. View changed to 'reviewStagedGroup'.`, 'debug');
        } else {
            this.logger('Cleared current editing staged group ID.', 'debug');
        }
        this._onStateChanged.fire({ ...this._state });
    }
}