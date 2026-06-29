import request, { type RequestResponse } from '../request';
import { TrendingSince as MTrendingSince } from '../models/trendingSince';

interface GitHubReadmeResponse {
    content: string;
}

export const getTrending = async (since: MTrendingSince): Promise<RequestResponse<string>> => {
    return request<string>({
        url: `https://github.com/trending?since=${since}`,
        method: 'GET',
        responseType: 'text',
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
