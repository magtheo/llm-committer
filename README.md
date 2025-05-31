# LLM-Committer for VS Code

[![Version](https://img.shields.io/visual-studio-marketplace/v/theo-dev.llm-committer?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=theo-dev.llm-committer)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/theo-dev.llm-committer)](https://marketplace.visualstudio.com/items?itemName=theo-dev.llm-committer)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/theo-dev.llm-committer)](https://marketplace.visualstudio.com/items?itemName=theo-dev.llm-committer)
<!-- Optional: Add a license badge if you wish -->
<!-- [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) -->

**LLM-Committer** is a Visual Studio Code extension designed to help you write clear, conventional, and contextual Git commit messages with the power of Large Language Models (LLMs).

Streamline your commit workflow by automatically generating insightful commit messages based on your staged changes. Supports multiple LLM providers like OpenAI, Anthropic, Google Gemini, and OpenRouter.

**(Consider adding a GIF here showing the main workflow: selecting files, generating a message, staging, and committing)**
<!-- ![LLM-Committer Demo GIF](https://example.com/path/to/your/demo.gif) -->

## Features

*   **AI-Powered Commit Messages:** Generates commit messages by analyzing file diffs.
*   **Multiple LLM Provider Support:**
    *   OpenAI (GPT models)
    *   Anthropic (Claude models)
    *   Google (Gemini models)
    *   OpenRouter (Access a variety of models)
*   **Contextual Understanding:**
    *   **General Context:** Provide project-wide or feature-specific context that applies to all generated messages within the workspace.
    *   **Group-Specific Context:** Add context for a specific group of changes before generating a message.
*   **Flexible Workflow:**
    *   **Group Changes:** Select specific changed files to form a logical commit group.
    *   **Generate or Write Manually:** Get an AI-generated suggestion or write your own message.
    *   **Edit and Refine:** Easily edit generated messages. Regenerate if needed.
    *   **Stage & Commit:** Stage files and commit your groups directly from the extension.
*   **Customizable LLM Behavior:**
    *   Configure model, max tokens, and temperature.
    *   Provide custom instructions to tailor the LLM's output style (e.g., conventional commits, specific tone).
*   **Integrated Git Operations:**
    *   View changed files.
    *   View diffs for individual files.
    *   Revert changes for selected files.
*   **Secure API Key Storage:** Uses VS Code's secure SecretStorage for API keys.
*   **Settings UI:** Easily configure providers, API keys, and LLM parameters within the extension view.
*   **Detailed Logging:** Provides an "LLM Committer" Output Channel for verbose logging and troubleshooting.

## Requirements

*   **Git:** Must be installed and initialized in your project.
*   **API Key:** An API key for your chosen LLM provider (OpenAI, Anthropic, Gemini, or OpenRouter).

## Getting Started

1.  **Install the Extension:** Search for "LLM-Committer" in the VS Code Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`) and click Install.
2.  **Open the LLM Committer View:** Click the LLM Committer icon (typically a robot icon: $(robot)) in the Activity Bar.
3.  **Configure Settings:**
    *   Click the gear icon $(gear) at the top of the LLM Committer view or use the command palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) and search for "LLM Committer: Settings".
    *   **Select AI Provider:** Choose your preferred LLM provider (e.g., OpenAI).
    *   **Enter API Key:** Enter your API key for the selected provider and click "Save".
    *   **Configure Model (Optional):** Select a model, adjust max tokens, and temperature as needed. Click "Save Model Settings".
    *   **Custom Instructions (Optional):** Add custom instructions for the LLM. Click "Save Instructions".
    *   Click "Test Connection" to ensure your API key and settings are working.

**(Consider adding a screenshot here of the settings view)**
<!-- ![LLM-Committer Settings Screenshot](https://example.com/path/to/your/settings_screenshot.png) -->

## Usage Workflow

1.  **Make Changes:** Modify files in your Git repository.
2.  **Open LLM Committer:** Access the extension via the Activity Bar.
3.  **Refresh (Optional):** Click the refresh icon $(refresh) if changes aren't appearing. Changes are also refreshed on file save.
4.  **Add General Context (Optional):** If you have overarching context for your current work session (e.g., ticket number, feature name), add it to the "General Context" text area. This is saved per workspace.
5.  **Select Files for Grouping:**
    *   In the "Available Changes" list, check the boxes next to the files you want to include in a single commit.
    *   Click "Create Group (X)" where X is the number of selected files.
6.  **In the Group View:**
    *   Review the files in the group.
    *   **Add Group Specific Context (Optional):** Provide context specific to only this group of changes.
    *   **Generate Commit Message:** Click "🤖 Generate Message". The LLM will analyze the diffs and context to suggest a message.
    *   **Edit or Regenerate:** Modify the generated message or click "🤖 Generate Message" again for a new suggestion.
    *   Click "Stage Group".
7.  **Review Staged Groups:**
    *   The group now appears under "Staged Groups".
    *   You can "Edit" a staged group (to change its files, context, or message) or "Unstage" it.
8.  **Commit:**
    *   Once you have one or more staged groups, click "Commit All Staged Groups".
    *   The extension will stage the files for each group and commit them sequentially.
    *   Progress and results will be shown as VS Code notifications and detailed logs in the "LLM Committer" Output Channel.

**(Consider adding a screenshot/GIF here of the main workflow: selecting files, group view, commit message)**
<!-- ![LLM-Committer Main Workflow Screenshot](https://example.com/path/to/your/workflow_screenshot.png) -->

## Extension Settings

This extension contributes the following settings (accessible via VS Code Settings UI or `settings.json`):

*   `llmCommitter.llmProvider`: (string, default: `"openai"`)
    *   Description: AI provider to use for generating commit messages.
    *   Enum: `"openai"`, `"anthropic"`, `"gemini"`, `"openrouter"`
*   `llmCommitter.llmInstructions`: (string, default: `""`)
    *   Description: Custom instructions for the LLM when generating commit messages. Leave empty to use default instructions (focused on conventional commits).
*   `llmCommitter.llmModel`: (string, default: `"gpt-4o-mini"` or provider-specific default)
    *   Description: Model to use for generating commit messages. Available models depend on the selected provider.
*   `llmCommitter.maxTokens`: (number, default: `4000`)
    *   Description: Maximum number of tokens to use for the entire LLM request (prompt + completion).
    *   Minimum: `1000`, Maximum: `8000`
*   `llmCommitter.temperature`: (number, default: `0.3`)
    *   Description: Temperature setting for LLM creativity (0 = deterministic/consistent, 1 = highly creative/random).
    *   Minimum: `0`, Maximum: `1`
*   `llmCommitter.openRouterRefererUrl`: (string, default: `"http://localhost"`)
    *   Description: HTTP Referer URL to use for OpenRouter API calls. Optional, but recommended by OpenRouter. Can be your website or a unique identifier for your extension usage. This is configured in VS Code settings, not directly in the extension's UI panel.

**Note on API Keys:** API keys are stored securely using VS Code's SecretStorage and are not synced with settings sync. They are configured via the extension's UI panel.

## Commands

*   `LLM Committer: Refresh`: Refreshes the list of changed files. (Icon: $(refresh))
*   `LLM Committer: Settings`: Opens the settings view within the LLM Committer panel. (Icon: $(gear))

## Known Issues

*   *(List any known issues or limitations here. Be transparent!)*
*   Example: "Performance may vary for very large diffs or a high number of changed files."
*   Example: "Some LLM models might be more sensitive to prompt structure than others."

## Release Notes

See the [CHANGELOG.md](CHANGELOG.md) file for details on changes in each version.

### 0.0.1 (Initial Release Date)

*   Initial release of LLM-Committer.
*   Features: ...
*   ...

## Contributing

Contributions, issues, and feature requests are welcome! Please check the [issues page]([YOUR_REPOSITORY_URL]/issues) to see if your issue or idea has already been discussed.

If you'd like to contribute:
1.  Fork the repository.
2.  Create your feature branch (`git checkout -b feature/AmazingFeature`).
3.  Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4.  Push to the branch (`git push origin feature/AmazingFeature`).
5.  Open a Pull Request.

## Development

To run and debug the extension locally:

1.  Clone the repository: `git clone [YOUR_REPOSITORY_URL]`
2.  Install dependencies: `npm install`
3.  Build the extension and webview: `npm run build`
    *   Or for development with watching: `npm run dev` (runs Vite and TSC in watch mode concurrently).
4.  Open the project in VS Code.
5.  Press `F5` to open a new VS Code Extension Development Host window with the extension loaded.
6.  You can set breakpoints in your TypeScript files (`src/`) and they will be hit.
7.  The webview source is in the `webview/` directory and uses React with Vite.

## License

This project is licensed under the [YOUR_LICENSE_NAME e.g., MIT] License - see the [LICENSE](LICENSE) file for details.

---

Happy Committing! If you find this extension useful, please consider leaving a review on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=theo-dev.llm-committer).