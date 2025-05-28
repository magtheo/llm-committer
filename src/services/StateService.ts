// src/services/StateService.ts
import * as vscode from 'vscode';
import { LLMProvider } from './ConfigurationService'; // Import the exported type

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

export interface AppState {
    changedFiles: string[];
    currentGroup: CurrentGroup | null;
    currentView: 'fileselection' | 'group' | 'settings' | 'reviewStagedGroup';
    selectedFiles: string[];
    generalContext: string;

    settings: {
        hasApiKey: boolean;
        provider: LLMProvider; // Use the imported type
        model: string;
        maxTokens: number;
        temperature: number;
        instructionsLength: number;
    };
    stagedGroups: StagedGroup[];
    currentEditingStagedGroupId: string | null;
}

export class StateService {
    private context: vscode.ExtensionContext | undefined; 

    private _state: AppState = {
        changedFiles: [],
        currentGroup: null,
        currentView: 'fileselection',
        selectedFiles: [],
        generalContext: '',
        settings: {
            hasApiKey: false,
            provider: 'openai', // Default provider
            model: 'gpt-4o-mini', // Default model for the default provider
            maxTokens: 4000,
            temperature: 0.3,
            instructionsLength: 0
        },
        stagedGroups: [],
        currentEditingStagedGroupId: null,
    };

    private _onStateChanged = new vscode.EventEmitter<AppState>();
    public readonly onStateChanged = this._onStateChanged.event;

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
        this._state.changedFiles = files;
        this._state.selectedFiles = this._state.selectedFiles.filter(file => 
            files.includes(file)
        );

        let stagedGroupsModified = false;
        this._state.stagedGroups = this._state.stagedGroups.map(group => {
            const originalFileCount = group.files.length;
            const updatedFiles = group.files.filter(sf => files.includes(sf));

            if (updatedFiles.length !== originalFileCount) {
                stagedGroupsModified = true;
                if (updatedFiles.length === 0) {
                    console.warn(`[StateService] Staged group ${group.id} became empty and will be removed.`);
                    return null; 
                }
                return { ...group, files: updatedFiles };
            }
            return group;
        }).filter(group => group !== null) as StagedGroup[];

        if (stagedGroupsModified) {
            this.persistStagedGroups();
        }

        this._onStateChanged.fire({ ...this._state });
    }

    public setSelectedFiles(files: string[]): void {
        this._state.selectedFiles = files;
        this._onStateChanged.fire({ ...this._state });
    }

    public toggleFileSelection(filePath: string): void {
        const index = this._state.selectedFiles.indexOf(filePath);
        if (index === -1) {
            this._state.selectedFiles.push(filePath);
        } else {
            this._state.selectedFiles.splice(index, 1);
        }
        this._onStateChanged.fire({ ...this._state });
    }

    public startNewGroup(files: string[]): void {
        const filesAlreadyStaged = new Set(this._state.stagedGroups.flatMap(g => g.files));
        const filesForNewGroup = files.filter(f => !filesAlreadyStaged.has(f));

        if (filesForNewGroup.length === 0 && files.length > 0) {
            vscode.window.showWarningMessage("All selected files are already in other staged groups.");
            return;
        }
        if (filesForNewGroup.length === 0) {
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
        this._onStateChanged.fire({ ...this._state });
    }

    public clearCurrentGroup(): void {
        this._state.currentGroup = null;
        this._state.currentView = 'fileselection';
        this._state.currentEditingStagedGroupId = null; 
        this._onStateChanged.fire({ ...this._state });
    }

    public updateCurrentGroupSpecificContext(context: string): void {
        if (this._state.currentGroup) {
            this._state.currentGroup.specificContext = context;
            this._onStateChanged.fire({ ...this._state });
        }
    }

    public updateCurrentGroupCommitMessage(message: string): void {
        if (this._state.currentGroup) {
            this._state.currentGroup.commitMessage = message;
            this._onStateChanged.fire({ ...this._state });
        }
    }

    public setCurrentView(view: AppState['currentView']): void {
        this._state.currentView = view;
        if (view !== 'reviewStagedGroup') {
            this._state.currentEditingStagedGroupId = null; 
        }
        this._onStateChanged.fire({ ...this._state });
    }

    public setGeneralContext(context: string): void {
        this._state.generalContext = context;
        this._onStateChanged.fire({ ...this._state });
    }

    public getGeneralContext(): string {
        return this._state.generalContext;
    }

    public setGeneratingMessage(isGenerating: boolean): void {
        if (this._state.currentGroup) {
            this._state.currentGroup.isGenerating = isGenerating;
            this._onStateChanged.fire({ ...this._state });
        } else if (this._state.currentEditingStagedGroupId) {
            const group = this._state.stagedGroups.find(g => g.id === this._state.currentEditingStagedGroupId);
            if (group) {
                console.log("[StateService] Generating message for staged group (UI should handle indicator)");
            }
        }
    }

    public isGeneratingMessage(): boolean {
        return this._state.currentGroup?.isGenerating || false;
    }

    public updateSettings(settings: Partial<AppState['settings']>): void {
        this._state.settings = { ...this._state.settings, ...settings };
        this._onStateChanged.fire({ ...this._state });
    }

    public getSettings(): AppState['settings'] {
        return { ...this._state.settings };
    }

    public loadStagedGroups(): void {
        if (!this.context) {
            return;
        }
        const persistedGroups = this.context.workspaceState.get<StagedGroup[]>('llmCommitter.stagedGroups');
        if (persistedGroups) {
            this._state.stagedGroups = persistedGroups;
            console.log('[StateService] Loaded staged groups from workspace state:', persistedGroups.length);
        } else {
            this._state.stagedGroups = [];
        }
    }

    public persistStagedGroups(): void {
        if (!this.context) {
            return;
        }
        this.context.workspaceState.update('llmCommitter.stagedGroups', this._state.stagedGroups)
            .then(() => console.log('[StateService] Persisted staged groups to workspace state.'),
                  (err) => console.error('[StateService] Error persisting staged groups:', err));
    }

    public stageCurrentGroup(): boolean {
        if (!this._state.currentGroup || !this._state.currentGroup.commitMessage?.trim()) {
            console.warn('[StateService] Attempted to stage group without current group or commit message.');
            vscode.window.showErrorMessage("Cannot stage group: commit message is missing.");
            return false;
        }
        if (this._state.currentGroup.files.length === 0) {
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
        this.clearCurrentGroup(); 
        console.log('[StateService] Group staged:', newStagedGroup.id);
        return true;
    }

    public unstageGroup(groupId: string): void {
        const groupIndex = this._state.stagedGroups.findIndex(g => g.id === groupId);
        if (groupIndex > -1) {
            const unstagedGroup = this._state.stagedGroups.splice(groupIndex, 1)[0];
            this.persistStagedGroups();
            console.log('[StateService] Group unstaged:', groupId);

            if (this._state.currentEditingStagedGroupId === groupId) {
                this._state.currentEditingStagedGroupId = null;
                this._state.currentView = 'fileselection'; 
            }
            this._onStateChanged.fire({ ...this._state });
            vscode.window.showInformationMessage(`Group "${unstagedGroup.commitMessage.substring(0,20)}..." unstaged.`);
        } else {
            console.warn('[StateService] Attempted to unstage non-existent group:', groupId);
        }
    }
    
    public removeStagedGroupById(groupId: string): void {
        const initialLength = this._state.stagedGroups.length;
        this._state.stagedGroups = this._state.stagedGroups.filter(g => g.id !== groupId);
        if (this._state.stagedGroups.length < initialLength) {
            this.persistStagedGroups();
            console.log('[StateService] Staged group removed after commit:', groupId);
            this._onStateChanged.fire({ ...this._state });
        }
    }

    public updateStagedGroup(groupId: string, updates: Partial<Pick<StagedGroup, 'specificContext' | 'commitMessage' | 'files'>>): void {
        const groupIndex = this._state.stagedGroups.findIndex(g => g.id === groupId);
        if (groupIndex > -1) {
            const group = this._state.stagedGroups[groupIndex];
            if (updates.files && updates.files.length === 0) {
                vscode.window.showWarningMessage("A staged group cannot have zero files. Unstage the group instead if you want to remove all files.");
                delete updates.files; 
            }

            this._state.stagedGroups[groupIndex] = { ...group, ...updates };
            this.persistStagedGroups();
            console.log('[StateService] Staged group updated:', groupId, updates);
            this._onStateChanged.fire({ ...this._state });
        } else {
            console.warn('[StateService] Attempted to update non-existent staged group:', groupId);
        }
    }

    public removeFileFromStagedGroup(groupId: string, filePathToRemove: string): void {
        const groupIndex = this._state.stagedGroups.findIndex(g => g.id === groupId);
        if (groupIndex > -1) {
            const group = this._state.stagedGroups[groupIndex];
            const updatedFiles = group.files.filter(f => f !== filePathToRemove);

            if (updatedFiles.length === 0) {
                this.unstageGroup(groupId);
                vscode.window.showInformationMessage(`Group became empty and was unstaged.`);
            } else if (updatedFiles.length < group.files.length) {
                this._state.stagedGroups[groupIndex] = { ...group, files: updatedFiles };
                this.persistStagedGroups();
                console.log('[StateService] File removed from staged group:', groupId, filePathToRemove);
                this._onStateChanged.fire({ ...this._state });
            }
        } else {
            console.warn('[StateService] Attempted to remove file from non-existent staged group:', groupId);
        }
    }

    public setCurrentEditingStagedGroupId(groupId: string | null): void {
        this._state.currentEditingStagedGroupId = groupId;
        if (groupId) {
            this._state.currentView = 'reviewStagedGroup';
        }
        this._onStateChanged.fire({ ...this._state });
    }
}