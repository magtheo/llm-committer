import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
  const command = 'llm-committer.openWebview';
  
  const commandHandler = () => {
    // Create and show panel
    const panel = vscode.window.createWebviewPanel(
      'reactWebview',
      'React Webview',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'dist'))
        ]
      }
    );
    
    // Get path to webview bundle
    const webviewPath = path.join(context.extensionPath, 'dist', 'webview');
    const indexPath = path.join(webviewPath, 'index.html');
    
    // Load HTML content
    let indexHtml = fs.readFileSync(indexPath, 'utf8');
    
    // Fix paths for assets
    const webviewUri = panel.webview.asWebviewUri(
      vscode.Uri.file(webviewPath)
    );
    indexHtml = indexHtml.replace(
      /(href|src)="(.+)"/g,
      (match, attr, value) => {
        if (value.startsWith('/')) {
          return `${attr}="${webviewUri.toString()}${value}"`;
        }
        return match;
      }
    );
    
    panel.webview.html = indexHtml;
    
    // Handle messages from webview
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
  };
  
  context.subscriptions.push(
    vscode.commands.registerCommand(command, commandHandler)
  );
}

export function deactivate() {}