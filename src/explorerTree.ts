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

const normalizeText = (value: string): string => {
    return value.replace(/\s+/g, ' ').trim();
};

interface TooltipDetails {
    description: string;
    forkCount: string;
    language: string;
    repositoryUrl: string;
    starCount: string;
    userName: string;
}

const cacheTtl = 15 * 60 * 1000;
const refreshRetryDelay = 60 * 1000;

interface CacheEntry {
    nodes: vscode.TreeItem[];
    updatedAt: number;
}

const createTooltip = (details: TooltipDetails): vscode.MarkdownString => {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendText(details.description || 'No description');
    tooltip.appendMarkdown('\n\n**Author:** ');
    tooltip.appendText(details.userName);
    tooltip.appendMarkdown('\n\n**Language:** ');
    tooltip.appendText(details.language || 'Unknown');
    tooltip.appendMarkdown('\n\n**Stars:** ');
    tooltip.appendText(details.starCount || 'Unknown');
    tooltip.appendMarkdown('\n\n**Forks:** ');
    tooltip.appendText(details.forkCount || 'Unknown');
    tooltip.appendMarkdown('\n\n**Link:** ');
    tooltip.appendMarkdown(`[${details.repositoryUrl}](${details.repositoryUrl})`);

    return tooltip;
};

export class ExplorerTree implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly onDidChangeTreeDataEvent = new vscode.EventEmitter<
        vscode.TreeItem | undefined
    >();
    public readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> =
        this.onDidChangeTreeDataEvent.event;
    private treeView: vscode.TreeView<vscode.TreeItem> | undefined;
    private cache: CacheEntry | undefined;
    private forceRefresh = false;
    private lastRefreshErrorMessage: string | undefined;
    private retryRefreshAfter = 0;
    private activeRequest:
        | {
              controller: AbortController;
              promise: Promise<vscode.TreeItem[]>;
          }
        | undefined;

    public constructor(private readonly since: MTrendingSince) {}

    public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    public setTreeView(treeView: vscode.TreeView<vscode.TreeItem>): void {
        this.treeView = treeView;
    }

    public async getChildren(): Promise<vscode.TreeItem[]> {
        if (this.activeRequest) {
            return this.cache?.nodes ?? this.activeRequest.promise;
        }

        if (!this.shouldRefresh()) {
            if (this.cache && !this.isCacheExpired() && !this.lastRefreshErrorMessage) {
                this.setMessage(undefined);
            }
            return this.getCurrentNodes();
        }

        this.startRefresh();

        if (this.cache) {
            return this.cache.nodes;
        }

        return this.activeRequest?.promise ?? [];
    }

    public refresh(): void {
        this.activeRequest?.controller.abort();
        this.activeRequest = undefined;
        this.forceRefresh = true;
        this.setRefreshMessage();
        this.onDidChangeTreeDataEvent.fire(undefined);
    }

    private shouldRefresh(): boolean {
        if (this.forceRefresh) {
            return true;
        }

        if (Date.now() < this.retryRefreshAfter) {
            return false;
        }

        return !this.cache || this.isCacheExpired();
    }

    private isCacheExpired(): boolean {
        return this.cache ? Date.now() - this.cache.updatedAt >= cacheTtl : true;
    }

    private startRefresh(): void {
        const controller = new AbortController();
        const promise = this.loadTrending(controller);
        this.forceRefresh = false;
        this.setRefreshMessage();
        this.activeRequest = {
            controller,
            promise,
        };
    }

    private async loadTrending(controller: AbortController): Promise<vscode.TreeItem[]> {
        const hadCachedResults = Boolean(this.cache);
        try {
            const response = await RGetTrending(this.since, controller.signal);
            const $ = cheerio.load(response.data);
            const items = $('.Box-row');
            if (items.length === 0) {
                throw new Error(
                    'GitHub Trending returned no repository rows; the page structure may have changed',
                );
            }

            const nodes: vscode.TreeItem[] = [];
            items.each((_index, item) => {
                const repositoryLink = $(item).find('h2 a[href]').first();
                const repositoryPath = repositoryLink.attr('href')?.trim();
                if (!repositoryPath) {
                    return;
                }

                const [userName, repoName] = repositoryPath.replace(/^\/+/, '').split('/');
                if (!userName || !repoName) {
                    return;
                }

                const description = normalizeText($(item).find('.my-1').text());
                const starCount = normalizeText(
                    $(item).find(`a[href="${repositoryPath}/stargazers"]`).first().text(),
                );
                const forkCount = normalizeText(
                    $(item).find(`a[href="${repositoryPath}/forks"]`).first().text(),
                );
                const language = normalizeText(
                    $(item).find('span[itemprop="programmingLanguage"]').text(),
                );
                const repositoryUrl = `https://github.com${repositoryPath}`;
                const node = new vscode.TreeItem(repoName, vscode.TreeItemCollapsibleState.None);
                node.description = starCount ? `☆ ${starCount}` : undefined;
                node.tooltip = createTooltip({
                    description,
                    forkCount,
                    language,
                    repositoryUrl,
                    starCount,
                    userName,
                });
                const treeIcon = getTreeIcon(language);
                node.iconPath = treeIcon.iconPath;
                node.resourceUri = treeIcon.resourceUri;
                node.command = {
                    command: 'github-trending.select',
                    title: repoName,
                    arguments: [userName, repoName],
                };
                nodes.push(node);
            });

            if (nodes.length === 0) {
                throw new Error(
                    'GitHub Trending repository rows could not be parsed; the page structure may have changed',
                );
            }

            if (controller.signal.aborted || this.activeRequest?.controller !== controller) {
                return this.getCurrentNodes();
            }

            this.cache = {
                nodes,
                updatedAt: Date.now(),
            };
            this.lastRefreshErrorMessage = undefined;
            this.retryRefreshAfter = 0;
            this.setMessage(undefined);

            if (hadCachedResults) {
                this.onDidChangeTreeDataEvent.fire(undefined);
            }
            return nodes;
        } catch (error) {
            if (
                isAbortError(error) ||
                controller.signal.aborted ||
                this.activeRequest?.controller !== controller
            ) {
                return this.getCurrentNodes();
            }

            this.retryRefreshAfter = Date.now() + refreshRetryDelay;
            const errorDetail = getErrorDetail(error);
            if (this.cache) {
                const updatedAt = new Date(this.cache.updatedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                });
                this.lastRefreshErrorMessage = `${errorDetail}. Showing cached results from ${updatedAt}. Run Refresh to try again.`;
                this.setMessage(this.lastRefreshErrorMessage);
                return this.cache.nodes;
            }

            this.lastRefreshErrorMessage = `${errorDetail}. Run Refresh to try again.`;
            this.setMessage(this.lastRefreshErrorMessage);
            return [];
        } finally {
            if (this.activeRequest?.controller === controller) {
                this.activeRequest = undefined;
            }
        }
    }

    private setRefreshMessage(): void {
        const action = this.cache ? 'Refreshing' : 'Loading';
        this.setMessage(`${action} ${this.since} trending repositories...`);
    }

    private setMessage(message: string | undefined): void {
        if (this.treeView) {
            this.treeView.message = message;
        }
    }

    private getCurrentNodes(): vscode.TreeItem[] {
        return this.cache?.nodes ?? [];
    }
}
