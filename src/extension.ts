// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path'; // Make sure path is imported if you use it
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
  console.log('Extension "llm-committer" is now active!'); // This will run when the command is first invoked.
  const commandId = 'llm-committer.openWebview';

  // Define the handler function for your command
  const commandHandler = () => {
    const extensionUri = context.extensionUri;

    const panel = vscode.window.createWebviewPanel(
      'reactWebview',
      'React Webview',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')]
      }
    );

    const webviewBuildDiskPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    const indexPathOnDisk = vscode.Uri.joinPath(webviewBuildDiskPath, 'index.html');
    let indexHtml = fs.readFileSync(indexPathOnDisk.fsPath, 'utf8');

    indexHtml = indexHtml.replace(/(href|src)="\.(.+?)"/g, (match, attr, relativePath) => {
      const assetDiskPath = vscode.Uri.joinPath(webviewBuildDiskPath, relativePath);
      const assetWebviewUri = panel.webview.asWebviewUri(assetDiskPath);
      return `${attr}="${assetWebviewUri}"`;
    });

    panel.webview.html = indexHtml;

    panel.webview.onDidReceiveMessage(
      message => {
        switch (message.command) {
          case 'alert':
            vscode.window.showInformationMessage(message.text);
            return;
        }
      },
      undefined,
      context.subscriptions
    );
  }; // <--- commandHandler function definition ends here

  // Register the command. This line should be directly in activate.
  context.subscriptions.push(
    vscode.commands.registerCommand(commandId, commandHandler)
  );
} // <--- activate function ends here

export function deactivate() {}