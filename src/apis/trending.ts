import request, { type RequestResponse } from '../request';
import { TrendingSince as MTrendingSince } from '../models/trendingSince';

export interface GitHubReadmeResponse {
    content: string;
    download_url: string | null;
    encoding: string;
    html_url: string;
    path: string;
}

export const getTrending = async (
    since: MTrendingSince,
    signal?: AbortSignal,
): Promise<RequestResponse<string>> => {
    return request<string>({
        url: `https://github.com/trending?since=${since}`,
        method: 'GET',
        responseType: 'text',
        signal,
    });
};

interface Params {
    userName: string;
    repoName: string;
}

interface ReadmeRequestOptions {
    etag?: string;
    signal?: AbortSignal;
}

export const getRepoReadmeInfo = async (
    param: Params,
    options: ReadmeRequestOptions = {},
): Promise<RequestResponse<GitHubReadmeResponse | null>> => {
    return request<GitHubReadmeResponse | null>({
        url: `https://api.github.com/repos/${param.userName}/${param.repoName}/readme`,
        method: 'GET',
        headers: {
            Accept: 'application/vnd.github+json',
            ...(options.etag ? { 'If-None-Match': options.etag } : {}),
        },
        signal: options.signal,
        acceptedStatuses: [304],
    });
};
