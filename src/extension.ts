import * as vscode from 'vscode';
import { marked } from 'marked';
import { ExplorerTree } from './explorerTree';
import { getRepoReadmeInfo as RGetRepoReadmeInfo } from './apis/trending';
import { TrendingSince as MTrendingSince } from './models/trendingSince';
import { createReadmeWebviewHtml, decodeReadme } from './readmeWebview';

const getErrorDetail = (error: unknown): string => {
    return error instanceof Error ? error.message : 'Failed to load README';
};

export const activate = (context: vscode.ExtensionContext): void => {
    const createTrendingView = (
        viewId: string,
        since: MTrendingSince,
    ): {
        provider: ExplorerTree;
        treeView: vscode.TreeView<vscode.TreeItem>;
    } => {
        const provider = new ExplorerTree(since);
        const treeView = vscode.window.createTreeView(viewId, {
            treeDataProvider: provider,
        });
        provider.setTreeView(treeView);

        return {
            provider,
            treeView,
        };
    };

    const dailyView = createTrendingView('trendingDaily', MTrendingSince.Daily);
    const weeklyView = createTrendingView('trendingWeekly', MTrendingSince.Weekly);
    const monthlyView = createTrendingView('trendingMonthly', MTrendingSince.Monthly);

    let webviewPanel: vscode.WebviewPanel | undefined;
    const getWebviewPanel = (): vscode.WebviewPanel => {
        if (!webviewPanel) {
            const panel = vscode.window.createWebviewPanel(
                'github-trending',
                'Github Trending',
                vscode.ViewColumn.One,
                {
                    enableScripts: false,
                    enableForms: false,
                    enableCommandUris: false,
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
            const readme = decodeReadme(response.data);
            const markdown = await marked(readme);
            const html = createReadmeWebviewHtml(
                panel.webview,
                userName,
                repoName,
                response.data,
                markdown,
            );

            panel.webview.html = html;
        } catch (error) {
            vscode.window.showWarningMessage(getErrorDetail(error));
        }
    };

    context.subscriptions.push(
        dailyView.treeView,
        weeklyView.treeView,
        monthlyView.treeView,
        vscode.commands.registerCommand('github-trending.dailyRefresh', () => {
            dailyView.provider.refresh();
        }),
        vscode.commands.registerCommand('github-trending.weeklyRefresh', () => {
            weeklyView.provider.refresh();
        }),
        vscode.commands.registerCommand('github-trending.monthlyRefresh', () => {
            monthlyView.provider.refresh();
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
