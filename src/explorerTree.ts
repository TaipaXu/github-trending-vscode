import * as vscode from 'vscode';
import * as cheerio from 'cheerio';
import { getTrending as RGetTrending } from './apis/trending';
import { TrendingSince as MTrendingSince } from './models/trendingSince';
import getTreeIcon from './utils/icon';

const getErrorDetail = (error: unknown): string => {
    return error instanceof Error ? error.message : 'Failed to load trending repositories';
};

export class ExplorerTree implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly onDidChangeTreeDataEvent = new vscode.EventEmitter<
        vscode.TreeItem | undefined
    >();
    public readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> =
        this.onDidChangeTreeDataEvent.event;
    private since: MTrendingSince | undefined;

    public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    public async getChildren(): Promise<vscode.TreeItem[]> {
        if (this.since === undefined) {
            return [];
        }
        const nodes: vscode.TreeItem[] = [];
        try {
            const response = await RGetTrending(this.since);
            const $ = cheerio.load(response.data);
            const items = $('.Box-row');
            items.each((_index, item) => {
                const title = $(item).find('.lh-condensed').text().replace(/\s+/g, '');
                const [userName, repoName] = title.split('/');
                if (!userName || !repoName) {
                    return;
                }

                const description = $(item).find('.my-1').text().trim();
                const startCount = $(item).find('a.mr-3').first().text().replace(/\s+/g, '');
                const language = $(item).find('span[itemprop="programmingLanguage"]').text();

                const node = new vscode.TreeItem(repoName, vscode.TreeItemCollapsibleState.None);
                node.description = `    ☆ ${startCount}`;
                node.tooltip = description;
                node.iconPath = getTreeIcon(language.toLowerCase());
                node.command = {
                    command: 'github-trending.select',
                    title: repoName,
                    arguments: [userName, repoName],
                };
                nodes.push(node);
            });
        } catch (error) {
            vscode.window.showWarningMessage(getErrorDetail(error));
        }
        return nodes;
    }

    public getTrending(since: MTrendingSince): void {
        this.since = since;
        this.onDidChangeTreeDataEvent.fire(undefined);
    }
}
