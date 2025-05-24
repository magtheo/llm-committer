// src/extension.ts
import * as vscode from 'vscode';
// path is not used in this snippet, but good to keep if you plan to use it.
// import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
  console.log('Extension "llm-committer" is now active!');
  const commandId = 'llm-committer.openWebview';

  const commandHandler = () => {
    const extensionUri = context.extensionUri;

    const panel = vscode.window.createWebviewPanel(
      'reactWebview',
      'React Webview',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        // Ensure localResourceRoots allows access to the 'dist/webview/assets' directory if your assets are there
        // Or more broadly 'dist/webview' which you already have.
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')]
      }
    );

    const webviewBuildDiskPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    const indexPathOnDisk = vscode.Uri.joinPath(webviewBuildDiskPath, 'index.html');

    try {
      let indexHtml = fs.readFileSync(indexPathOnDisk.fsPath, 'utf8');
      console.log('[LLM-Committer] Original index.html loaded.');

      // Replace CSP source placeholder first
      indexHtml = indexHtml.replace(/\${webview.cspSource}/g, panel.webview.cspSource);
      console.log('[LLM-Committer] CSP source replaced.');

      // Regex to match paths like "/assets/filename.ext"
      indexHtml = indexHtml.replace(/(href|src)="(\/assets\/[^"]+)"/g, (match, attr, assetPathWithSlash) => {
          const relativePath = assetPathWithSlash.substring(1); // e.g., "assets/main.js"
          const assetDiskPath = vscode.Uri.joinPath(webviewBuildDiskPath, relativePath);
          const assetWebviewUri = panel.webview.asWebviewUri(assetDiskPath);
          console.log(`[LLM-Committer] Rewriting ${attr}: ${assetPathWithSlash} -> ${assetWebviewUri.toString()}`);
          return `${attr}="${assetWebviewUri.toString()}"`;
      });
      // Log the HTML after replacement to verify paths
      // console.log('[LLM-Committer] HTML after path replacement:', indexHtml);

      panel.webview.html = indexHtml;
      console.log('[LLM-Committer] Webview HTML set.');

    } catch (e) {
      console.error('[LLM-Committer] Error loading or processing webview HTML:', e);
      vscode.window.showErrorMessage('Failed to load LLM Committer webview: ' + (e as Error).message);
      panel.webview.html = `<h1>Error loading webview</h1><p>${(e as Error).message}</p>`;
      return;
    }


    panel.webview.onDidReceiveMessage(
      message => {
        console.log('[LLM-Committer] Message received from webview:', message);
        switch (message.command) {
          case 'alert':
            vscode.window.showInformationMessage(message.text);
            return;
        }
      },
      undefined,
      context.subscriptions
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(commandId, commandHandler)
  );
}

export function deactivate() {}