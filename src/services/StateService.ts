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

export interface AppSettingsState { // Renamed to avoid conflict with AppState from App.tsx if imported there
    hasApiKey: boolean;
    provider: LLMProvider;
    model: string;
    maxTokens: number;
    temperature: number;
    instructionsLength: number;
    openRouterRefererUrl?: string; // Added based on App.tsx
}

export interface AppState {
    changedFiles: string[];
    currentGroup: CurrentGroup | null;
    currentView: 'fileselection' | 'group' | 'settings' | 'reviewStagedGroup';
    selectedFiles: string[];
    generalContext: string;
    settings: AppSettingsState;
    stagedGroups: StagedGroup[];
    currentEditingStagedGroupId: string | null;
}

// Define a type for the logger function
type LoggerFunction = (
    message: string,
    type?: 'info' | 'error' | 'warning' | 'debug',
    showPopup?: boolean
) => void;


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
            openRouterRefererUrl: 'http://localhost', // Default from package.json
        },
        stagedGroups: [],
        currentEditingStagedGroupId: null,
    };

    private _onStateChanged = new vscode.EventEmitter<AppState>();
    public readonly onStateChanged = this._onStateChanged.event;

    constructor(logger: LoggerFunction) {
        this.logger = logger;
    }

    public initialize(context: vscode.ExtensionContext): void {
        this.context = context;
        this.loadStagedGroups();
        this.logger('StateService initialized.', 'debug');
    }

    private generateGroupId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2);
    }

    public get state(): AppState {
        return JSON.parse(JSON.stringify(this._state)); // Deep copy to prevent direct mutation
    }

    public setChangedFiles(files: string[]): void {
        this._state.changedFiles = files;
        this._state.selectedFiles = this._state.selectedFiles.filter(file =>
            files.includes(file)
        );

        let stagedGroupsModified = false;
        const originalStagedGroupCount = this._state.stagedGroups.length;
        this._state.stagedGroups = this._state.stagedGroups.map(group => {
            const originalFileCountInGroup = group.files.length;
            const updatedFiles = group.files.filter(sf => files.includes(sf));

            if (updatedFiles.length !== originalFileCountInGroup) {
                stagedGroupsModified = true;
                if (updatedFiles.length === 0) {
                    this.logger(`Staged group ${group.id} ("${group.commitMessage.substring(0,20)}...") became empty and will be removed.`, 'warning');
                    return null;
                }
                this.logger(`Files in staged group ${group.id} updated due to external changes. Old count: ${originalFileCountInGroup}, New count: ${updatedFiles.length}`, 'debug');
                return { ...group, files: updatedFiles };
            }
            return group;
        }).filter(group => group !== null) as StagedGroup[];

        if (stagedGroupsModified || this._state.stagedGroups.length !== originalStagedGroupCount) {
            this.persistStagedGroups();
        }

        this._onStateChanged.fire(this.state);
    }

    public setSelectedFiles(files: string[]): void {
        this._state.selectedFiles = files;
        this._onStateChanged.fire(this.state);
    }

    public toggleFileSelection(filePath: string): void {
        const index = this._state.selectedFiles.indexOf(filePath);
        if (index === -1) {
            this._state.selectedFiles.push(filePath);
        } else {
            this._state.selectedFiles.splice(index, 1);
        }
        this._onStateChanged.fire(this.state);
    }

    public startNewGroup(files: string[]): void {
        const filesAlreadyStaged = new Set(this._state.stagedGroups.flatMap(g => g.files));
        const filesForNewGroup = files.filter(f => !filesAlreadyStaged.has(f));

        if (filesForNewGroup.length === 0 && files.length > 0) {
            this.logger("All selected files are already in other staged groups.", 'warning', true);
            return;
        }
        if (filesForNewGroup.length === 0) {
            this.logger("No files available for new group (either none selected or all already staged).", 'warning', true);
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
        this.logger(`Starting new group with ${filesForNewGroup.length} files.`, 'debug');
        this._onStateChanged.fire(this.state);
    }

    public clearCurrentGroup(): void {
        this._state.currentGroup = null;
        this._state.currentView = 'fileselection';
        this._state.currentEditingStagedGroupId = null;
        this.logger('Current group cleared, returning to file selection.', 'debug');
        this._onStateChanged.fire(this.state);
    }

    public updateCurrentGroupSpecificContext(context: string): void {
        if (this._state.currentGroup) {
            this._state.currentGroup.specificContext = context;
            this._onStateChanged.fire(this.state);
        }
    }

    public updateCurrentGroupCommitMessage(message: string): void {
        if (this._state.currentGroup) {
            this._state.currentGroup.commitMessage = message;
            this._onStateChanged.fire(this.state);
        }
    }

    public setCurrentView(view: AppState['currentView']): void {
        this._state.currentView = view;
        if (view !== 'reviewStagedGroup') {
            this._state.currentEditingStagedGroupId = null;
        }
        this.logger(`Current view changed to: ${view}`, 'debug');
        this._onStateChanged.fire(this.state);
    }

    public setGeneralContext(context: string): void {
        this._state.generalContext = context;
        this._onStateChanged.fire(this.state);
    }

    public getGeneralContext(): string {
        return this._state.generalContext;
    }

    public setGeneratingMessage(isGenerating: boolean): void {
        let targetGroupIdentifier = "unknown";
        if (this._state.currentGroup) {
            this._state.currentGroup.isGenerating = isGenerating;
            targetGroupIdentifier = "current (new) group";
        } else if (this._state.currentEditingStagedGroupId) {
            // For staged groups, the UI (App.tsx) handles its own isGenerating indicator
            // based on messages from extension.ts. StateService doesn't need to track it.
            targetGroupIdentifier = `staged group ${this._state.currentEditingStagedGroupId}`;
        }
        this.logger(`Setting message generation status for ${targetGroupIdentifier} to: ${isGenerating}`, 'debug');
        this._onStateChanged.fire(this.state);
    }

    public isGeneratingMessage(): boolean { // For current (new) group
        return this._state.currentGroup?.isGenerating || false;
    }

    public updateSettings(settings: Partial<AppSettingsState>): void {
        this._state.settings = { ...this._state.settings, ...settings };
        this.logger(`Settings updated in state: ${JSON.stringify(Object.keys(settings))}`, 'debug');
        this._onStateChanged.fire(this.state);
    }

    public getSettings(): AppSettingsState {
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
            this.logger('No staged groups found in workspace state.', 'debug');
        }
    }

    public persistStagedGroups(): void {
        if (!this.context) {
            this.logger('Context not available for persisting staged groups.', 'warning');
            return;
        }
        this.context.workspaceState.update('llmCommitter.stagedGroups', this._state.stagedGroups)
            .then(
                () => this.logger(`Persisted ${this._state.stagedGroups.length} staged groups to workspace state.`, 'debug'),
                (err) => this.logger(`Error persisting staged groups: ${err}`, 'error')
            );
    }

    public stageCurrentGroup(): boolean {
        if (!this._state.currentGroup || !this._state.currentGroup.commitMessage?.trim()) {
            this.logger('Attempted to stage group without current group or commit message.', 'warning', true);
            // vscode.window.showErrorMessage("Cannot stage group: commit message is missing."); // Handled by caller
            return false;
        }
        if (this._state.currentGroup.files.length === 0) {
            this.logger("Cannot stage group: no files in the group.", 'warning', true);
            // vscode.window.showErrorMessage("Cannot stage group: no files in the group."); // Handled by caller
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
        this.logger(`Group ${newStagedGroup.id} staged with ${newStagedGroup.files.length} files. Total staged: ${this._state.stagedGroups.length}`, 'info');
        this.clearCurrentGroup(); // This also fires state change
        return true;
    }

    public unstageGroup(groupId: string): void {
        const groupIndex = this._state.stagedGroups.findIndex(g => g.id === groupId);
        if (groupIndex > -1) {
            const unstagedGroup = this._state.stagedGroups.splice(groupIndex, 1)[0];
            this.persistStagedGroups();
            this.logger(`Group ${groupId} ("${unstagedGroup.commitMessage.substring(0,20)}...") unstaged.`, 'info');

            if (this._state.currentEditingStagedGroupId === groupId) {
                this._state.currentEditingStagedGroupId = null;
                this._state.currentView = 'fileselection';
            }
            this._onStateChanged.fire(this.state);
            // vscode.window.showInformationMessage(`Group "${unstagedGroup.commitMessage.substring(0,20)}..." unstaged.`); // Handled by caller
        } else {
            this.logger(`Attempted to unstage non-existent group: ${groupId}`, 'warning');
        }
    }

    public removeStagedGroupById(groupId: string): void {
        const initialLength = this._state.stagedGroups.length;
        this._state.stagedGroups = this._state.stagedGroups.filter(g => g.id !== groupId);
        if (this._state.stagedGroups.length < initialLength) {
            this.persistStagedGroups();
            this.logger(`Staged group ${groupId} removed (e.g., after commit).`, 'debug');
            this._onStateChanged.fire(this.state);
        }
    }

    public updateStagedGroup(groupId: string, updates: Partial<Pick<StagedGroup, 'specificContext' | 'commitMessage' | 'files'>>): void {
        const groupIndex = this._state.stagedGroups.findIndex(g => g.id === groupId);
        if (groupIndex > -1) {
            const group = this._state.stagedGroups[groupIndex];
            if (updates.files && updates.files.length === 0) {
                this.logger("Attempt to update staged group to have zero files. This is not allowed directly; unstage the group instead.", 'warning', true);
                // vscode.window.showWarningMessage("A staged group cannot have zero files. Unstage the group instead if you want to remove all files."); // Handled by caller
                delete updates.files; // Prevent making it empty
            }

            this._state.stagedGroups[groupIndex] = { ...group, ...updates };
            this.persistStagedGroups();
            this.logger(`Staged group ${groupId} updated with keys: ${JSON.stringify(Object.keys(updates))}`, 'debug');
            this._onStateChanged.fire(this.state);
        } else {
            this.logger(`Attempted to update non-existent staged group: ${groupId}`, 'warning');
        }
    }

    public removeFileFromStagedGroup(groupId: string, filePathToRemove: string): void {
        const groupIndex = this._state.stagedGroups.findIndex(g => g.id === groupId);
        if (groupIndex > -1) {
            const group = this._state.stagedGroups[groupIndex];
            const originalFileCount = group.files.length;
            const updatedFiles = group.files.filter(f => f !== filePathToRemove);

            if (updatedFiles.length === 0) {
                this.logger(`Removing last file from staged group ${groupId}. Group will be unstaged.`, 'info');
                this.unstageGroup(groupId); // This handles persistence and state update
                // vscode.window.showInformationMessage(`Group "${group.commitMessage.substring(0,20)}..." became empty and was unstaged.`); // Handled by caller
            } else if (updatedFiles.length < originalFileCount) {
                this._state.stagedGroups[groupIndex] = { ...group, files: updatedFiles };
                this.persistStagedGroups();
                this.logger(`File ${filePathToRemove} removed from staged group ${groupId}.`, 'debug');
                this._onStateChanged.fire(this.state);
            }
        } else {
            this.logger(`Attempted to remove file from non-existent staged group: ${groupId}`, 'warning');
        }
    }

    public setCurrentEditingStagedGroupId(groupId: string | null): void {
        this._state.currentEditingStagedGroupId = groupId;
        if (groupId) {
            this._state.currentView = 'reviewStagedGroup';
            this.logger(`Set current editing staged group ID to: ${groupId}, view to reviewStagedGroup.`, 'debug');
        } else {
            // If clearing the editing ID, don't automatically change view unless it was reviewStagedGroup
            if (this._state.currentView === 'reviewStagedGroup') {
                 this._state.currentView = 'fileselection';
                 this.logger(`Cleared current editing staged group ID, view reset to fileselection.`, 'debug');
            }
        }
        this._onStateChanged.fire(this.state);
    }
}