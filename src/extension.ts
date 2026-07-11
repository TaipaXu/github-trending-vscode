import * as vscode from 'vscode';
import { marked } from 'marked';
import { ExplorerTree } from './explorerTree';
import {
    getRepoReadmeInfo as RGetRepoReadmeInfo,
    type GitHubReadmeResponse,
} from './apis/trending';
import { TrendingSince as MTrendingSince } from './models/trendingSince';
import { RequestError, RequestTimeoutError } from './request';
import {
    createReadmeStatusWebviewHtml,
    createReadmeWebviewHtml,
    decodeReadme,
} from './readmeWebview';

const readmeCacheMaxEntries = 20;
const readmeCacheTtl = 10 * 60 * 1000;

interface ReadmeCacheEntry {
    readmeInfo: GitHubReadmeResponse;
    markdownHtml: string;
    etag?: string;
    validatedAt: number;
}

interface ReadmeLoadResult {
    entry: ReadmeCacheEntry;
    updated: boolean;
}

interface InFlightReadmeRequest {
    controller: AbortController;
    promise: Promise<ReadmeLoadResult>;
}

const isAbortError = (error: unknown): boolean => {
    return (
        (error instanceof Error && error.name === 'AbortError') ||
        (typeof error === 'object' &&
            error !== null &&
            'name' in error &&
            error.name === 'AbortError')
    );
};

const getGitHubErrorMessage = (error: RequestError): string => {
    const data = error.response.data;
    if (typeof data !== 'object' || data === null || !('message' in data)) {
        return '';
    }

    return typeof data.message === 'string' ? data.message : '';
};

const getRateLimitResetTime = (headers: Record<string, string>): string | undefined => {
    const resetAt = Number(headers['x-ratelimit-reset']);
    if (!Number.isFinite(resetAt) || resetAt * 1000 <= Date.now()) {
        return undefined;
    }

    return new Date(resetAt * 1000).toLocaleTimeString(vscode.env.language, {
        hour: '2-digit',
        minute: '2-digit',
    });
};

const isRateLimitError = (error: RequestError): boolean => {
    const { headers, status } = error.response;
    const responseMessage = getGitHubErrorMessage(error).toLowerCase();
    return (
        status === 429 ||
        (status === 403 &&
            (headers['x-ratelimit-remaining'] === '0' ||
                Boolean(headers['retry-after']) ||
                responseMessage.includes('rate limit')))
    );
};

const getReadmeErrorDetail = (error: unknown): string => {
    if (error instanceof RequestTimeoutError) {
        return vscode.l10n.t('GitHub took too long to respond. Try again.');
    }

    if (error instanceof RequestError) {
        const { headers, status } = error.response;
        if (status === 404) {
            return vscode.l10n.t('This repository does not have an accessible README.');
        }

        if (isRateLimitError(error)) {
            const resetTime = getRateLimitResetTime(headers);
            return resetTime
                ? vscode.l10n.t('GitHub API rate limit reached. Try again after {0}.', resetTime)
                : vscode.l10n.t('GitHub API rate limit reached. Try again later.');
        }

        if (status === 401 || status === 403) {
            return vscode.l10n.t('GitHub denied access to this README (HTTP {0}).', status);
        }

        if (status >= 500) {
            return vscode.l10n.t(
                'GitHub is temporarily unavailable (HTTP {0}). Try again later.',
                status,
            );
        }

        return vscode.l10n.t('GitHub README request failed (HTTP {0}). Try again.', status);
    }

    if (error instanceof TypeError && error.message.toLowerCase().includes('fetch')) {
        return vscode.l10n.t(
            'Unable to connect to GitHub. Check your internet connection and try again.',
        );
    }

    return error instanceof Error
        ? vscode.l10n.t('Failed to display README: {0}', error.message)
        : vscode.l10n.t('Failed to load README.');
};

export const activate = (context: vscode.ExtensionContext): void => {
    const createTrendingView = (
        viewId: string,
        since: MTrendingSince,
        title: string,
    ): {
        provider: ExplorerTree;
        treeView: vscode.TreeView<vscode.TreeItem>;
    } => {
        const provider = new ExplorerTree(since);
        const treeView = vscode.window.createTreeView(viewId, {
            treeDataProvider: provider,
        });
        treeView.title = title;
        provider.setTreeView(treeView);

        return {
            provider,
            treeView,
        };
    };

    const dailyView = createTrendingView(
        'trendingDaily',
        MTrendingSince.Daily,
        vscode.l10n.t('Daily'),
    );
    const weeklyView = createTrendingView(
        'trendingWeekly',
        MTrendingSince.Weekly,
        vscode.l10n.t('Weekly'),
    );
    const monthlyView = createTrendingView(
        'trendingMonthly',
        MTrendingSince.Monthly,
        vscode.l10n.t('Monthly'),
    );

    const readmeCache = new Map<string, ReadmeCacheEntry>();
    const inFlightReadmeRequests = new Map<string, InFlightReadmeRequest>();
    let activeReadmeRequestKey: string | undefined;
    let webviewPanel: vscode.WebviewPanel | undefined;
    let readmeLoadVersion = 0;

    const getReadmeKey = (userName: string, repoName: string): string => {
        return `${userName}/${repoName}`.toLowerCase();
    };

    const getCachedReadme = (key: string): ReadmeCacheEntry | undefined => {
        const entry = readmeCache.get(key);
        if (entry) {
            readmeCache.delete(key);
            readmeCache.set(key, entry);
        }
        return entry;
    };

    const setCachedReadme = (key: string, entry: ReadmeCacheEntry): void => {
        readmeCache.delete(key);
        readmeCache.set(key, entry);

        while (readmeCache.size > readmeCacheMaxEntries) {
            const oldestKey = readmeCache.keys().next().value;
            if (typeof oldestKey !== 'string') {
                break;
            }
            readmeCache.delete(oldestKey);
        }
    };

    const isCachedReadmeFresh = (entry: ReadmeCacheEntry): boolean => {
        return Date.now() - entry.validatedAt < readmeCacheTtl;
    };

    const loadReadme = async (
        key: string,
        userName: string,
        repoName: string,
        cachedEntry: ReadmeCacheEntry | undefined,
        signal: AbortSignal,
    ): Promise<ReadmeLoadResult> => {
        const response = await RGetRepoReadmeInfo(
            {
                userName,
                repoName,
            },
            {
                etag: cachedEntry?.etag,
                signal,
            },
        );
        signal.throwIfAborted();

        if (response.status === 304) {
            if (!cachedEntry) {
                throw new Error(
                    vscode.l10n.t('GitHub returned Not Modified without a cached README'),
                );
            }

            const validatedEntry = {
                ...cachedEntry,
                validatedAt: Date.now(),
            };
            setCachedReadme(key, validatedEntry);
            return {
                entry: validatedEntry,
                updated: false,
            };
        }

        if (!response.data) {
            throw new Error(vscode.l10n.t('GitHub returned an empty README response'));
        }

        const readme = decodeReadme(response.data);
        const markdownHtml = await marked(readme);
        signal.throwIfAborted();

        const entry: ReadmeCacheEntry = {
            readmeInfo: {
                ...response.data,
                content: '',
            },
            markdownHtml,
            etag: response.headers.etag,
            validatedAt: Date.now(),
        };
        setCachedReadme(key, entry);
        return {
            entry,
            updated: true,
        };
    };

    const getOrCreateReadmeRequest = (
        key: string,
        userName: string,
        repoName: string,
        cachedEntry: ReadmeCacheEntry | undefined,
    ): InFlightReadmeRequest => {
        const existingRequest = inFlightReadmeRequests.get(key);
        if (existingRequest && !existingRequest.controller.signal.aborted) {
            return existingRequest;
        }

        if (existingRequest) {
            inFlightReadmeRequests.delete(key);
        }

        const controller = new AbortController();
        const promise = loadReadme(key, userName, repoName, cachedEntry, controller.signal);
        const request = {
            controller,
            promise,
        };
        inFlightReadmeRequests.set(key, request);

        const removeRequest = (): void => {
            if (inFlightReadmeRequests.get(key) === request) {
                inFlightReadmeRequests.delete(key);
            }
        };
        void promise.then(removeRequest, removeRequest);

        return request;
    };

    const abortActiveReadmeRequest = (nextKey?: string): void => {
        if (!activeReadmeRequestKey || activeReadmeRequestKey === nextKey) {
            return;
        }

        inFlightReadmeRequests.get(activeReadmeRequestKey)?.controller.abort();
        activeReadmeRequestKey = undefined;
    };

    const abortAllReadmeRequests = (): void => {
        inFlightReadmeRequests.forEach((request) => request.controller.abort());
        inFlightReadmeRequests.clear();
        activeReadmeRequestKey = undefined;
    };

    const getWebviewPanel = (): vscode.WebviewPanel => {
        if (!webviewPanel) {
            const panel = vscode.window.createWebviewPanel(
                'github-trending',
                vscode.l10n.t('GitHub Trending'),
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    enableForms: false,
                    enableCommandUris: false,
                },
            );
            webviewPanel = panel;
            panel.onDidDispose(() => {
                if (webviewPanel === panel) {
                    readmeLoadVersion += 1;
                    abortAllReadmeRequests();
                    webviewPanel = undefined;
                }
            });
        }

        return webviewPanel;
    };

    const renderReadme = (
        panel: vscode.WebviewPanel,
        userName: string,
        repoName: string,
        entry: ReadmeCacheEntry,
    ): void => {
        panel.webview.html = createReadmeWebviewHtml(
            panel.webview,
            userName,
            repoName,
            entry.readmeInfo,
            entry.markdownHtml,
        );
    };

    const showReadme = async (userName: string, repoName: string): Promise<void> => {
        const panel = getWebviewPanel();
        const loadVersion = ++readmeLoadVersion;
        const key = getReadmeKey(userName, repoName);
        abortActiveReadmeRequest(key);
        activeReadmeRequestKey = key;

        panel.title = repoName;
        panel.reveal(panel.viewColumn ?? vscode.ViewColumn.One);
        const cachedEntry = getCachedReadme(key);
        if (cachedEntry) {
            renderReadme(panel, userName, repoName, cachedEntry);
        } else {
            panel.webview.html = createReadmeStatusWebviewHtml(
                panel.webview,
                userName,
                repoName,
                vscode.l10n.t('Loading README...'),
                'status',
            );
        }

        if (cachedEntry && isCachedReadmeFresh(cachedEntry)) {
            activeReadmeRequestKey = undefined;
            return;
        }

        const request = getOrCreateReadmeRequest(key, userName, repoName, cachedEntry);
        try {
            const result = await request.promise;

            if (loadVersion !== readmeLoadVersion || panel !== webviewPanel) {
                return;
            }

            if (result.updated || !cachedEntry) {
                renderReadme(panel, userName, repoName, result.entry);
            }
        } catch (error) {
            if (
                request.controller.signal.aborted ||
                isAbortError(error) ||
                loadVersion !== readmeLoadVersion ||
                panel !== webviewPanel
            ) {
                return;
            }

            const errorDetail = getReadmeErrorDetail(error);
            if (!cachedEntry) {
                panel.webview.html = createReadmeStatusWebviewHtml(
                    panel.webview,
                    userName,
                    repoName,
                    errorDetail,
                    'alert',
                );
            }
            const warningMessage = cachedEntry
                ? vscode.l10n.t('{0} Showing cached README.', errorDetail)
                : errorDetail;
            vscode.window.showWarningMessage(warningMessage);
        } finally {
            if (activeReadmeRequestKey === key) {
                activeReadmeRequestKey = undefined;
            }
        }
    };

    context.subscriptions.push(
        new vscode.Disposable(abortAllReadmeRequests),
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
            async (item?: vscode.TreeItem) => {
                const eventArguments: readonly unknown[] = item?.command?.arguments ?? [];
                const userName = eventArguments[0];
                const repoName = eventArguments[1];
                if (typeof userName !== 'string' || typeof repoName !== 'string') {
                    return;
                }

                await vscode.env.openExternal(
                    vscode.Uri.parse(`https://github.com/${userName}/${repoName}`),
                );
            },
        ),
    );
};

export const deactivate = (): void => {};
