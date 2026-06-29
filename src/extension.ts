import * as vscode from 'vscode';
import { marked } from 'marked';
import { ExplorerTree } from './explorerTree';
import { getRepoReadmeInfo as RGetRepoReadmeInfo } from './apis/trending';
import { TrendingSince as MTrendingSince } from './models/trendingSince';

const getErrorDetail = (error: unknown): string => {
    return error instanceof Error ? error.message : 'Failed to load README';
};

export const activate = (context: vscode.ExtensionContext): void => {
    const explorerTree: ExplorerTree = new ExplorerTree();
    const treeDataProvider = vscode.window.registerTreeDataProvider('trending', explorerTree);

    let webviewPanel: vscode.WebviewPanel | undefined;
    const getWebviewPanel = (): vscode.WebviewPanel => {
        if (!webviewPanel) {
            const panel = vscode.window.createWebviewPanel(
                'github-trending',
                'Github Trending',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                },
            );
            webviewPanel = panel;
            panel.onDidDispose(() => {
                if (webviewPanel === panel) {
                    webviewPanel = undefined;
                }
            });
        }

        return webviewPanel;
    };

    const showReadme = async (userName: string, repoName: string): Promise<void> => {
        const panel = getWebviewPanel();
        panel.title = repoName;
        panel.reveal(panel.viewColumn ?? vscode.ViewColumn.One);

        try {
            const response = await RGetRepoReadmeInfo({
                userName,
                repoName,
            });
            const readme = Buffer.from(response.data.content, 'base64').toString('utf8');
            const markdown = await marked(readme);
            const html = `<!DOCTYPE html>
                <html>
                    <head>
                        <meta charset="utf-8">
                        <title>${repoName}</title>
                        <base href="https://raw.githubusercontent.com/${userName}/${repoName}/master/">
                    </head>
                    <body>
                        ${markdown}

                        <script>
                            window.addEventListener('message', (event) => {
                                if (event.data.type === 'init') {
                                    window.scroll(0, 0);
                                }
                            });
                        </script>
                    </body>
                </html>`;

            panel.webview.html = html;
            panel.webview.postMessage({
                type: 'init',
            });
        } catch (error) {
            vscode.window.showWarningMessage(getErrorDetail(error));
        }
    };

    context.subscriptions.push(
        treeDataProvider,
        vscode.commands.registerCommand('github-trending.daily', () => {
            explorerTree.getTrending(MTrendingSince.Daily);
        }),
        vscode.commands.registerCommand('github-trending.weekly', () => {
            explorerTree.getTrending(MTrendingSince.Weekly);
        }),
        vscode.commands.registerCommand('github-trending.monthly', () => {
            explorerTree.getTrending(MTrendingSince.Monthly);
        }),
        vscode.commands.registerCommand(
            'github-trending.select',
            async (userName: string, repoName: string) => {
                await showReadme(userName, repoName);
            },
        ),
        vscode.commands.registerCommand(
            'github-trending.openInBrowser',
            (item: vscode.TreeItem) => {
                const eventArguments: readonly unknown[] = item.command?.arguments ?? [];
                const userName = eventArguments[0];
                const repoName = eventArguments[1];
                if (typeof userName !== 'string' || typeof repoName !== 'string') {
                    return;
                }
                vscode.env.openExternal(
                    vscode.Uri.parse(`https://github.com/${userName}/${repoName}`),
                );
            },
        ),
    );
};

export const deactivate = (): void => {};
