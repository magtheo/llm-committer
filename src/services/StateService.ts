// src/services/StateService.ts - Phase 4: Add General Context
import * as vscode from 'vscode';

export interface CurrentGroup {
    files: string[];
    specificContext: string;
    commitMessage?: string;
}

export interface AppState {
    changedFiles: string[];
    currentGroup: CurrentGroup | null;
    currentView: 'fileselection' | 'group';
    selectedFiles: string[];
    generalContext: string; // Phase 4: Add general context
}

export class StateService {
    private _state: AppState = {
        changedFiles: [],
        currentGroup: null,
        currentView: 'fileselection',
        selectedFiles: [],
        generalContext: '' // Phase 4: Initialize general context
    };

    private _onStateChanged = new vscode.EventEmitter<AppState>();
    public readonly onStateChanged = this._onStateChanged.event;

    public get state(): AppState {
        return { ...this._state }; // Return a copy
    }

    public setChangedFiles(files: string[]): void {
        this._state.changedFiles = files;
        // Clear selected files if they no longer exist in changed files
        this._state.selectedFiles = this._state.selectedFiles.filter(file => 
            files.includes(file)
        );
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
        this._state.currentGroup = {
            files: [...files],
            specificContext: '',
            commitMessage: undefined
        };
        this._state.currentView = 'group';
        this._state.selectedFiles = []; // Clear selection after creating group
        this._onStateChanged.fire({ ...this._state });
    }

    public clearCurrentGroup(): void {
        this._state.currentGroup = null;
        this._state.currentView = 'fileselection';
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

    public setCurrentView(view: 'fileselection' | 'group'): void {
        this._state.currentView = view;
        this._onStateChanged.fire({ ...this._state });
    }

    // Phase 4: General context management
    public setGeneralContext(context: string): void {
        this._state.generalContext = context;
        this._onStateChanged.fire({ ...this._state });
    }

    public getGeneralContext(): string {
        return this._state.generalContext;
    }
}