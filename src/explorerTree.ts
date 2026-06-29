import * as vscode from 'vscode';
import * as cheerio from 'cheerio';
import { getTrending as RGetTrending } from './apis/trending';
import { TrendingSince as MTrendingSince } from './models/trendingSince';
import getTreeIcon from './utils/icon';

const getErrorDetail = (error: unknown): string => {
    return error instanceof Error ? error.message : 'Failed to load trending repositories';
};

const isAbortError = (error: unknown): boolean => {
    if (error instanceof Error && error.name === 'AbortError') {
        return true;
    }

    return (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'AbortError'
    );
};

export class ExplorerTree implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly onDidChangeTreeDataEvent = new vscode.EventEmitter<
        vscode.TreeItem | undefined
    >();
    public readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> =
        this.onDidChangeTreeDataEvent.event;
    private since: MTrendingSince | undefined;
    private treeView: vscode.TreeView<vscode.TreeItem> | undefined;
    private readonly cache = new Map<MTrendingSince, vscode.TreeItem[]>();
    private activeRequest:
        | {
              since: MTrendingSince;
              controller: AbortController;
              promise: Promise<vscode.TreeItem[]>;
          }
        | undefined;

    public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    public setTreeView(treeView: vscode.TreeView<vscode.TreeItem>): void {
        this.treeView = treeView;
    }

    public async getChildren(): Promise<vscode.TreeItem[]> {
        if (this.since === undefined) {
            this.setMessage(undefined);
            return [];
        }

        const cachedNodes = this.cache.get(this.since);
        if (cachedNodes) {
            this.setMessage(undefined);
            return cachedNodes;
        }

        if (this.activeRequest?.since === this.since) {
            this.setLoadingMessage(this.since);
            return this.activeRequest.promise;
        }

        this.activeRequest?.controller.abort();

        const since = this.since;
        const controller = new AbortController();
        const promise = this.loadTrending(since, controller);
        this.setLoadingMessage(since);
        this.activeRequest = {
            since,
            controller,
            promise,
        };

        return promise;
    }

    public getTrending(since: MTrendingSince): void {
        this.since = since;
        if (this.activeRequest?.since !== since) {
            this.activeRequest?.controller.abort();
            this.activeRequest = undefined;
        }
        if (this.cache.has(since)) {
            this.setMessage(undefined);
        } else {
            this.setLoadingMessage(since);
        }
        this.onDidChangeTreeDataEvent.fire(undefined);
    }

    public refresh(): void {
        if (this.since === undefined) {
            this.setMessage(undefined);
            this.onDidChangeTreeDataEvent.fire(undefined);
            return;
        }

        this.cache.delete(this.since);
        this.activeRequest?.controller.abort();
        this.activeRequest = undefined;
        this.setLoadingMessage(this.since);
        this.onDidChangeTreeDataEvent.fire(undefined);
    }

    private async loadTrending(
        since: MTrendingSince,
        controller: AbortController,
    ): Promise<vscode.TreeItem[]> {
        try {
            const response = await RGetTrending(since, controller.signal);
            const $ = cheerio.load(response.data);
            const items = $('.Box-row');
            const nodes: vscode.TreeItem[] = [];
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

            this.cache.set(since, nodes);
            if (this.since !== since) {
                return this.getCurrentNodes();
            }

            this.setMessage(undefined);
            return nodes;
        } catch (error) {
            if (isAbortError(error)) {
                return this.getCurrentNodes();
            }
            if (this.since === since) {
                this.setMessage(`${getErrorDetail(error)}. Run Refresh to try again.`);
            }
            return [];
        } finally {
            if (this.activeRequest?.controller === controller) {
                this.activeRequest = undefined;
            }
        }
    }

    private setLoadingMessage(since: MTrendingSince): void {
        this.setMessage(`Loading ${since} trending repositories...`);
    }

    private setMessage(message: string | undefined): void {
        if (this.treeView) {
            this.treeView.message = message;
        }
    }

    private getCurrentNodes(): vscode.TreeItem[] {
        return this.since === undefined ? [] : (this.cache.get(this.since) ?? []);
    }
}
