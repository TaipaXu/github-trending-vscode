import * as vscode from 'vscode';
import * as cheerio from 'cheerio';
import { randomBytes } from 'node:crypto';
import type { GitHubReadmeResponse } from './apis/trending';

const escapeHtmlMap: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

const escapeHtml = (value: string): string => {
    return value.replace(/[&<>"']/g, (char) => escapeHtmlMap[char]);
};

const createNonce = (): string => {
    return randomBytes(16).toString('base64');
};

const encodePath = (path: string): string => {
    return path.split('/').map(encodeURIComponent).join('/');
};

const getGitHubRepoUrl = (userName: string, repoName: string): string => {
    return `https://github.com/${encodeURIComponent(userName)}/${encodeURIComponent(repoName)}`;
};

const getDirectoryUrl = (url: string): string => {
    return new URL('.', url).toString();
};

const getReadmeDownloadBaseUrl = (
    userName: string,
    repoName: string,
    readmeInfo: GitHubReadmeResponse,
): string => {
    if (readmeInfo.download_url) {
        return getDirectoryUrl(readmeInfo.download_url);
    }

    const fallbackReadmeUrl = `${getGitHubRepoUrl(userName, repoName).replace(
        'https://github.com/',
        'https://raw.githubusercontent.com/',
    )}/HEAD/${encodePath(readmeInfo.path)}`;

    return getDirectoryUrl(fallbackReadmeUrl);
};

const resolveUrl = (
    value: string,
    baseUrl: string,
    isAllowedUrl: (url: URL, originalValue: string) => boolean,
): string | undefined => {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
        return undefined;
    }

    try {
        const url = new URL(trimmedValue, baseUrl);
        if (!isAllowedUrl(url, trimmedValue)) {
            return undefined;
        }

        return url.toString();
    } catch {
        return undefined;
    }
};

const isAllowedLinkUrl = (url: URL): boolean => {
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
};

const isAllowedImageUrl = (url: URL, originalValue: string): boolean => {
    if (url.protocol === 'data:') {
        return /^data:image\/(?:gif|jpe?g|png|svg\+xml|webp);/i.test(originalValue);
    }

    return url.protocol === 'https:';
};

const resolveReadmeLinkUrl = (
    href: string,
    readmeHtmlUrl: string,
    readmeHtmlBaseUrl: string,
): string | undefined => {
    const trimmedHref = href.trim();
    const baseUrl =
        trimmedHref.startsWith('#') || trimmedHref.startsWith('?')
            ? readmeHtmlUrl
            : readmeHtmlBaseUrl;

    return resolveUrl(trimmedHref, baseUrl, isAllowedLinkUrl);
};

export const decodeReadme = (readmeInfo: GitHubReadmeResponse): string => {
    if (readmeInfo.encoding !== 'base64') {
        throw new Error(`Unsupported README encoding: ${readmeInfo.encoding}`);
    }

    return Buffer.from(readmeInfo.content, 'base64').toString('utf8');
};

const sanitizeReadmeHtml = (
    html: string,
    readmeHtmlUrl: string,
    readmeDownloadBaseUrl: string,
): string => {
    const readmeHtmlBaseUrl = getDirectoryUrl(readmeHtmlUrl);
    const $ = cheerio.load(`<main>${html}</main>`, undefined, false);
    const root = $('main');

    root.find('script, style, iframe, object, embed, link, meta, base, form').remove();

    root.find('*').each((_index, element) => {
        const node = $(element);
        Object.keys(element.attribs ?? {}).forEach((attribute) => {
            const normalizedAttribute = attribute.toLowerCase();
            if (
                normalizedAttribute.startsWith('on') ||
                normalizedAttribute === 'style' ||
                normalizedAttribute === 'srcdoc' ||
                normalizedAttribute === 'srcset'
            ) {
                node.removeAttr(attribute);
            }
        });
    });

    root.find('a[href]').each((_index, element) => {
        const node = $(element);
        const href = node.attr('href');
        if (!href) {
            return;
        }

        const resolvedHref = resolveReadmeLinkUrl(href, readmeHtmlUrl, readmeHtmlBaseUrl);
        if (!resolvedHref) {
            node.removeAttr('href');
            return;
        }

        node.attr('href', resolvedHref);
        node.attr('target', '_blank');
        node.attr('rel', 'noopener noreferrer');
    });

    root.find('img[src]').each((_index, element) => {
        const node = $(element);
        const src = node.attr('src');
        if (!src) {
            node.remove();
            return;
        }

        const resolvedSrc = resolveUrl(src, readmeDownloadBaseUrl, isAllowedImageUrl);
        if (!resolvedSrc) {
            node.remove();
            return;
        }

        node.attr('src', resolvedSrc);
        node.attr('loading', 'lazy');
    });

    root.find('[href]').each((_index, element) => {
        if (element.tagName.toLowerCase() !== 'a') {
            $(element).removeAttr('href');
        }
    });

    root.find('[src]').each((_index, element) => {
        if (element.tagName.toLowerCase() !== 'img') {
            $(element).removeAttr('src');
        }
    });

    root.find('input').each((_index, element) => {
        const node = $(element);
        if (node.attr('type') !== 'checkbox') {
            node.remove();
            return;
        }

        node.attr('disabled', 'disabled');
    });

    return root.html() ?? '';
};

const getReadmeStyles = (): string => {
    return `
        :root {
            color-scheme: light dark;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            padding: 0;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            line-height: 1.6;
        }

        .readme-page {
            width: min(100%, 980px);
            margin: 0 auto;
            padding: 24px clamp(16px, 4vw, 32px) 48px;
        }

        .readme-toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            padding-bottom: 16px;
            margin-bottom: 24px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .repo-path {
            min-width: 0;
            overflow-wrap: anywhere;
            font-weight: 600;
        }

        .repo-path span {
            color: var(--vscode-descriptionForeground);
            font-weight: 400;
        }

        .readme-link {
            flex: 0 0 auto;
            padding: 4px 10px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            text-decoration: none;
            line-height: 1.4;
        }

        .readme-link:hover {
            background: var(--vscode-button-hoverBackground);
            color: var(--vscode-button-foreground);
            text-decoration: none;
        }

        .markdown-body {
            overflow-wrap: anywhere;
        }

        .markdown-body > :first-child {
            margin-top: 0;
        }

        .markdown-body > :last-child {
            margin-bottom: 0;
        }

        .markdown-body h1,
        .markdown-body h2,
        .markdown-body h3,
        .markdown-body h4,
        .markdown-body h5,
        .markdown-body h6 {
            margin: 24px 0 12px;
            color: var(--vscode-editor-foreground);
            line-height: 1.25;
        }

        .markdown-body h1,
        .markdown-body h2 {
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .markdown-body h1 {
            font-size: 1.8em;
        }

        .markdown-body h2 {
            font-size: 1.45em;
        }

        .markdown-body h3 {
            font-size: 1.2em;
        }

        .markdown-body a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }

        .markdown-body a:hover {
            color: var(--vscode-textLink-activeForeground);
            text-decoration: underline;
        }

        .markdown-body p,
        .markdown-body blockquote,
        .markdown-body ul,
        .markdown-body ol,
        .markdown-body dl,
        .markdown-body table,
        .markdown-body pre,
        .markdown-body details {
            margin: 0 0 16px;
        }

        .markdown-body ul,
        .markdown-body ol {
            padding-left: 2em;
        }

        .markdown-body blockquote {
            padding: 0 1em;
            border-left: 4px solid var(--vscode-textBlockQuote-border);
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-textBlockQuote-background);
        }

        .markdown-body hr {
            height: 1px;
            padding: 0;
            margin: 24px 0;
            border: 0;
            background: var(--vscode-panel-border);
        }

        .markdown-body table {
            display: block;
            width: max-content;
            max-width: 100%;
            overflow: auto;
            border-collapse: collapse;
        }

        .markdown-body th,
        .markdown-body td {
            padding: 6px 13px;
            border: 1px solid var(--vscode-panel-border);
        }

        .markdown-body tr:nth-child(2n) {
            background: var(--vscode-list-hoverBackground);
        }

        .markdown-body img {
            max-width: 100%;
            height: auto;
            border-style: none;
        }

        .markdown-body code,
        .markdown-body kbd,
        .markdown-body pre,
        .markdown-body samp {
            font-family: var(--vscode-editor-font-family), monospace;
        }

        .markdown-body :not(pre) > code {
            padding: 0.15em 0.35em;
            border-radius: 4px;
            background: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
            font-size: 0.92em;
        }

        .markdown-body pre {
            overflow: auto;
            padding: 16px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            background: var(--vscode-textCodeBlock-background);
            color: var(--vscode-editor-foreground);
        }

        .markdown-body pre code {
            display: block;
            padding: 0;
            overflow-wrap: normal;
            background: transparent;
            color: inherit;
            font-size: var(--vscode-editor-font-size);
            line-height: 1.5;
            white-space: pre;
            tab-size: 4;
        }

        .markdown-body kbd {
            display: inline-block;
            padding: 2px 5px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            background: var(--vscode-editorWidget-background);
            box-shadow: inset 0 -1px 0 var(--vscode-panel-border);
            font-size: 0.85em;
            line-height: 1.2;
        }

        .markdown-body details {
            padding: 8px 12px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
        }

        .markdown-body summary {
            cursor: pointer;
            font-weight: 600;
        }

        .markdown-body input[type='checkbox'] {
            margin: 0 0.4em 0.25em -1.4em;
            vertical-align: middle;
        }

        .readme-empty {
            color: var(--vscode-descriptionForeground);
        }

        @media (max-width: 600px) {
            .readme-toolbar {
                align-items: flex-start;
                flex-direction: column;
            }

            .readme-link {
                width: 100%;
                text-align: center;
            }
        }
    `;
};

export const createReadmeWebviewHtml = (
    webview: vscode.Webview,
    userName: string,
    repoName: string,
    readmeInfo: GitHubReadmeResponse,
    markdownHtml: string,
): string => {
    const nonce = createNonce();
    const repositoryUrl = getGitHubRepoUrl(userName, repoName);
    const readmeHtmlUrl = readmeInfo.html_url || repositoryUrl;
    const readmeDownloadBaseUrl = getReadmeDownloadBaseUrl(userName, repoName, readmeInfo);
    const renderedReadme = sanitizeReadmeHtml(markdownHtml, readmeHtmlUrl, readmeDownloadBaseUrl);
    const contentSecurityPolicy = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} https: data:`,
        `style-src ${webview.cspSource} 'nonce-${nonce}'`,
        `script-src 'none'`,
        `connect-src 'none'`,
        `object-src 'none'`,
        `frame-src 'none'`,
        `form-action 'none'`,
        `base-uri 'none'`,
    ].join('; ');

    return `<!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta
                    http-equiv="Content-Security-Policy"
                    content="${escapeHtml(contentSecurityPolicy)}"
                >
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>${escapeHtml(repoName)}</title>
                <style nonce="${escapeHtml(nonce)}">${getReadmeStyles()}</style>
            </head>
            <body>
                <div class="readme-page">
                    <header class="readme-toolbar">
                        <div class="repo-path">
                            <span>${escapeHtml(userName)} /</span> ${escapeHtml(repoName)}
                        </div>
                        <a class="readme-link" href="${escapeHtml(readmeHtmlUrl)}" target="_blank" rel="noopener noreferrer">
                            Open README
                        </a>
                    </header>
                    <main class="markdown-body">
                        ${renderedReadme || '<p class="readme-empty">README is empty.</p>'}
                    </main>
                </div>
            </body>
        </html>`;
};
