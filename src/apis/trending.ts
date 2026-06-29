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

export const getRepoReadmeInfo = async (
    param: Params,
): Promise<RequestResponse<GitHubReadmeResponse>> => {
    return request<GitHubReadmeResponse>({
        url: `https://api.github.com/repos/${param.userName}/${param.repoName}/readme`,
        method: 'GET',
        headers: {
            Accept: 'application/vnd.github+json',
        },
    });
};
