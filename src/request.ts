type RequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type ResponseType = 'json' | 'text' | 'arrayBuffer';

export interface RequestConfig {
    url: string;
    method?: RequestMethod;
    params?: Record<string, string | number | boolean | null | undefined>;
    headers?: Record<string, string>;
    responseType?: ResponseType;
    signal?: AbortSignal;
    acceptedStatuses?: number[];
}

export interface RequestResponse<T = unknown> {
    data: T;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    config: RequestConfig;
}

export class RequestError<T = unknown> extends Error {
    public constructor(
        message: string,
        public readonly response: RequestResponse<T>,
    ) {
        super(message);
        this.name = 'RequestError';
    }
}

export class RequestTimeoutError extends Error {
    public constructor(public readonly timeoutMs: number) {
        super(`Request timed out after ${timeoutMs}ms`);
        this.name = 'RequestTimeoutError';
    }
}

const timeout = 10000;
const defaultHeaders: Record<string, string> = {
    Accept: 'application/json, text/html, */*',
    'User-Agent': 'github-trending-vscode',
};

const buildUrl = (url: string, params?: RequestConfig['params']): string => {
    const requestUrl = new URL(url);

    if (params) {
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                requestUrl.searchParams.set(key, String(value));
            }
        });
    }

    return requestUrl.toString();
};

const parseData = async (response: Response, responseType?: ResponseType): Promise<unknown> => {
    if (responseType === 'arrayBuffer') {
        return response.arrayBuffer();
    }

    if (responseType === 'text') {
        return response.text();
    }

    const text = await response.text();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

const headersToObject = (headers: Headers): Record<string, string> => {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        result[key] = value;
    });
    return result;
};

const request = async <T = unknown>(config: RequestConfig): Promise<RequestResponse<T>> => {
    const method = config.method ?? 'GET';
    const controller = new AbortController();
    let abortSource: 'external' | 'timeout' | undefined;
    const abortRequest = (): void => {
        abortSource ??= 'external';
        controller.abort(config.signal?.reason);
    };
    const timer = setTimeout(() => {
        if (!abortSource) {
            abortSource = 'timeout';
            controller.abort();
        }
    }, timeout);

    if (config.signal?.aborted) {
        abortRequest();
    } else {
        config.signal?.addEventListener('abort', abortRequest, { once: true });
    }

    try {
        const response = await fetch(buildUrl(config.url, config.params), {
            method,
            headers: {
                ...defaultHeaders,
                ...config.headers,
            },
            signal: controller.signal,
        });
        const data = await parseData(response, config.responseType);

        const requestResponse: RequestResponse<T> = {
            data: data as T,
            status: response.status,
            statusText: response.statusText,
            headers: headersToObject(response.headers),
            config,
        };

        if (!response.ok && !config.acceptedStatuses?.includes(response.status)) {
            throw new RequestError(
                `Request failed with status code ${response.status}`,
                requestResponse,
            );
        }

        return requestResponse;
    } catch (error) {
        if (abortSource === 'timeout') {
            throw new RequestTimeoutError(timeout);
        }
        throw error;
    } finally {
        clearTimeout(timer);
        config.signal?.removeEventListener('abort', abortRequest);
    }
};

export default request;
