// src/services/StateService.ts - Phase 5+6: Enhanced with Settings State
import * as vscode from 'vscode';

export interface CurrentGroup {
    files: string[];
    specificContext: string;
    commitMessage?: string;
    isGenerating?: boolean; // Phase 5+6: Track message generation state
}

export interface StagedGroup {
    id: string; // Unique identifier for the group
    files: string[];
    specificContext: string;
    commitMessage: string;
    // Potentially add a timestamp for creation/staging if needed later
}

export interface AppState {
    changedFiles: string[];
    currentGroup: CurrentGroup | null;
    currentView: 'fileselection' | 'group' | 'settings' | 'reviewStagedGroup';
    selectedFiles: string[];
    generalContext: string;

    settings: {
        hasApiKey: boolean;
        provider: 'openai' | 'anthropic';
        model: string;
        maxTokens: number;
        temperature: number;
        instructionsLength: number;
    };
    stagedGroups: StagedGroup[];
    currentEditingStagedGroupId: string | null;
}

export class StateService {
    private context: vscode.ExtensionContext | undefined; // To store workspace state

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
            instructionsLength: 0
        },
        stagedGroups: [],
        currentEditingStagedGroupId: null,

    };

    private _onStateChanged = new vscode.EventEmitter<AppState>();
    public readonly onStateChanged = this._onStateChanged.event;

    // Call this in activate()
    public initialize(context: vscode.ExtensionContext): void {
        this.context = context;
        this.loadStagedGroups(); // Load persisted groups on activation
    }

    private generateGroupId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2);
    }

    public get state(): AppState {
        return { ...this._state }; // Return a copy
    }

    public setChangedFiles(files: string[]): void {
        this._state.changedFiles = files;
        // Clear selected files if they no longer exist in changed files
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
                    // If a group becomes empty, we might want to auto-unstage it or notify the user
                    // For now, let's keep it but log a warning. User can unstage manually.
                    // Or, alternatively, remove it. Let's remove it for now for simplicity.
                    console.warn(`[StateService] Staged group ${group.id} became empty and will be removed.`);
                    return null; // Mark for removal
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
            files: [...files],
            specificContext: '',
            commitMessage: undefined,
            isGenerating: false
        };
        this._state.currentView = 'group';
        this._state.selectedFiles = []; // Clear selection after creating group
        this._onStateChanged.fire({ ...this._state });
    }

    public clearCurrentGroup(): void {
        this._state.currentGroup = null;
        this._state.currentView = 'fileselection';
        this._state.currentEditingStagedGroupId = null; // Clear editing state too
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
            this._state.currentEditingStagedGroupId = null; // Clear editing state if not in review view
        }
        this._onStateChanged.fire({ ...this._state });
    }


    // General context management
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
            // Allow generating for a staged group being edited
            const group = this._state.stagedGroups.find(g => g.id === this._state.currentEditingStagedGroupId);
            if (group) {
                // This needs a temporary state in UI or a different state variable
                // For now, this won't directly affect isGenerating on the staged group itself
                // The UI will manage its own loading state for this.
                // A more robust solution might involve adding `isGenerating` to StagedGroup or AppState for editing.
                console.log("[StateService] Generating message for staged group (UI should handle indicator)");
            }
        }
    }

    public isGeneratingMessage(): boolean {
        return this._state.currentGroup?.isGenerating || false;
    }

    // Phase 5+6: Settings state management
    public updateSettings(settings: Partial<AppState['settings']>): void {
        this._state.settings = { ...this._state.settings, ...settings };
        this._onStateChanged.fire({ ...this._state });
    }

    public getSettings(): AppState['settings'] {
        return { ...this._state.settings };
    }

    public loadStagedGroups(): void {
        if (!this.context) return;
        const persistedGroups = this.context.workspaceState.get<StagedGroup[]>('llmCommitter.stagedGroups');
        if (persistedGroups) {
            this._state.stagedGroups = persistedGroups;
            console.log('[StateService] Loaded staged groups from workspace state:', persistedGroups.length);
        } else {
            this._state.stagedGroups = [];
        }
        // No fire here, usually called during init before listener is set up or as part of broader update.
        // If called later, ensure state is fired. For now, activate will load then send initial state.
    }

    public persistStagedGroups(): void {
        if (!this.context) return;
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
        this.clearCurrentGroup(); // This also sets view to fileselection and fires state change
        console.log('[StateService] Group staged:', newStagedGroup.id);
        return true;
    }

    public unstageGroup(groupId: string): void {
        const groupIndex = this._state.stagedGroups.findIndex(g => g.id === groupId);
        if (groupIndex > -1) {
            const unstagedGroup = this._state.stagedGroups.splice(groupIndex, 1)[0];
            this.persistStagedGroups();
            console.log('[StateService] Group unstaged:', groupId);

            // If this group was being edited, clear editing state
            if (this._state.currentEditingStagedGroupId === groupId) {
                this._state.currentEditingStagedGroupId = null;
                this._state.currentView = 'fileselection'; // Go back to main view
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
            // Ensure files are not empty if provided
            if (updates.files && updates.files.length === 0) {
                vscode.window.showWarningMessage("A staged group cannot have zero files. Unstage the group instead if you want to remove all files.");
                // Or, we could auto-unstage it. For now, prevent empty files.
                delete updates.files; // Don't apply empty files update
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
                // If removing the file makes the group empty, unstage the group.
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
        // If groupId is null, the view should be handled by the caller (e.g., navigate back to fileselection)
        this._onStateChanged.fire({ ...this._state });
    }
    
}