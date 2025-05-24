// src/services/StateService.ts
import * as vscode from 'vscode';

export interface AppState {
    changedFiles: string[];
    // Add other state properties here later
}

export class StateService {
    private _state: AppState = {
        changedFiles: [],
    };

    private _onStateChanged = new vscode.EventEmitter<AppState>();
    public readonly onStateChanged = this._onStateChanged.event;

    public get state(): AppState {
        return { ...this._state }; // Return a copy
    }

    public setChangedFiles(files: string[]): void {
        this._state.changedFiles = files;
        this._onStateChanged.fire({ ...this._state });
    }

    // Add other state mutators here
}