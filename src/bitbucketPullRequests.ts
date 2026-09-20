import * as https from 'https';
import { URL } from 'url';
import { BitbucketPullRequest, ErrorInfo, PullRequestConfig } from './types';

export interface BitbucketPullRequestResult {
	readonly pullRequests: BitbucketPullRequest[];
	readonly authenticationRequired: boolean;
	readonly error: ErrorInfo;
}

interface BitbucketApiPullRequest {
	id?: number;
	state?: string;
	title?: string;
	participants?: Array<{
		approved?: boolean;
		state?: string | null;
	}>;
	source?: {
		branch?: { name?: string };
		commit?: { hash?: string };
		repository?: { full_name?: string };
	};
	links?: { html?: { href?: string } };
}

interface BitbucketApiPage {
	values?: BitbucketApiPullRequest[];
	next?: string;
	error?: { message?: string; detail?: string };
}

interface HttpResponse {
	readonly statusCode: number;
	readonly body: string;
}

const BITBUCKET_API_HOST = 'api.bitbucket.org';
const CACHE_DURATION = 120000;
const MAX_CACHE_ENTRIES = 100;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_FILTER_LENGTH = 3000;
const MAX_BRANCHES_PER_FILTER = 50;
const BITBUCKET_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: MAX_CONCURRENT_REQUESTS });

interface CacheEntry {
	readonly expiresAt: number;
	readonly result: BitbucketPullRequestResult;
}

const cache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<BitbucketPullRequestResult>>();
let cacheGeneration = 0;

/**
 * Get all Bitbucket Cloud Pull Requests whose source is the configured repository.
 */
export function getBitbucketPullRequests(config: PullRequestConfig, apiToken: string | null, branches: ReadonlyArray<string>): Promise<BitbucketPullRequestResult> {
	if (!isBitbucketCloudUrl(config.hostRootUrl)) {
		return Promise.resolve({ pullRequests: [], authenticationRequired: false, error: 'Pull Request badges are only supported for Bitbucket Cloud.' });
	}

	const expectedSourceRepo = (config.sourceOwner + '/' + config.sourceRepo).toLowerCase();
	const sourceBranches = getSourceBranches(branches, config.sourceRemote);
	if (sourceBranches.length === 0) {
		return Promise.resolve({ pullRequests: [], authenticationRequired: false, error: null });
	}

	const cacheKey = [
		config.destOwner.toLowerCase(), config.destRepo.toLowerCase(), expectedSourceRepo,
		sourceBranches.join('\0')
	].join('\n');
	const cached = cache.get(cacheKey);
	if (typeof cached !== 'undefined' && cached.expiresAt > Date.now()) {
		cache.delete(cacheKey);
		cache.set(cacheKey, cached);
		return Promise.resolve(cached.result);
	}
	if (typeof cached !== 'undefined') cache.delete(cacheKey);
	const inFlight = inFlightRequests.get(cacheKey);
	if (typeof inFlight !== 'undefined') return inFlight;

	const generation = cacheGeneration;
	const requestPromise = loadBitbucketPullRequests(config, apiToken, expectedSourceRepo, sourceBranches).then((result) => {
		inFlightRequests.delete(cacheKey);
		if (generation === cacheGeneration && result.error === null && !result.authenticationRequired) {
			setCacheEntry(cacheKey, result);
		}
		return result;
	}, (err) => {
		inFlightRequests.delete(cacheKey);
		throw err;
	});
	inFlightRequests.set(cacheKey, requestPromise);
	return requestPromise;
}

/**
 * Clear all cached and in-flight Bitbucket Pull Request requests.
 */
export function clearBitbucketPullRequestCache() {
	cacheGeneration++;
	cache.clear();
	inFlightRequests.clear();
}

function setCacheEntry(key: string, result: BitbucketPullRequestResult) {
	const now = Date.now();
	cache.forEach((entry, cacheKey) => {
		if (entry.expiresAt <= now) cache.delete(cacheKey);
	});
	while (cache.size >= MAX_CACHE_ENTRIES) {
		const oldestKey = cache.keys().next().value;
		if (typeof oldestKey === 'undefined') break;
		cache.delete(oldestKey);
	}
	cache.set(key, { expiresAt: now + CACHE_DURATION, result: result });
}

async function loadBitbucketPullRequests(config: PullRequestConfig, apiToken: string | null, expectedSourceRepo: string, sourceBranches: ReadonlyArray<string>): Promise<BitbucketPullRequestResult> {
	const branchBatches = getBranchBatches(expectedSourceRepo, sourceBranches);
	const batchResults: BitbucketPullRequestResult[] = new Array(branchBatches.length);
	let nextBatch = 0;

	const worker = async () => {
		while (nextBatch < branchBatches.length) {
			const batchIndex = nextBatch++;
			batchResults[batchIndex] = await loadBitbucketPullRequestBatch(config, apiToken, expectedSourceRepo, branchBatches[batchIndex]);
		}
	};
	await Promise.all(new Array(Math.min(MAX_CONCURRENT_REQUESTS, branchBatches.length)).fill(null).map(worker));

	const failedResult = batchResults.find((result) => result.error !== null || result.authenticationRequired);
	if (typeof failedResult !== 'undefined') return failedResult;

	return {
		pullRequests: batchResults.reduce((pullRequests, result) => pullRequests.concat(result.pullRequests), <BitbucketPullRequest[]>[]),
		authenticationRequired: false,
		error: null
	};
}

async function loadBitbucketPullRequestBatch(config: PullRequestConfig, apiToken: string | null, expectedSourceRepo: string, sourceBranches: ReadonlyArray<string>): Promise<BitbucketPullRequestResult> {
	const query = getFilter(expectedSourceRepo, sourceBranches);
	let nextUrl: string | null = 'https://' + BITBUCKET_API_HOST + '/2.0/repositories/' + encodeURIComponent(config.destOwner) + '/' + encodeURIComponent(config.destRepo) +
		'/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&pagelen=50&q=' + encodeURIComponent(query) +
		'&fields=values.id,values.state,values.title,values.participants.approved,values.participants.state,values.source.branch.name,values.source.commit.hash,values.source.repository.full_name,values.links.html.href,next';
	const pullRequests: BitbucketPullRequest[] = [];
	const expectedSourceBranches = new Set(sourceBranches);

	while (nextUrl !== null) {
		let response: HttpResponse;
		try {
			response = await request(nextUrl, apiToken);
		} catch (err) {
			return { pullRequests: [], authenticationRequired: false, error: getErrorMessage(err) };
		}

		if (response.statusCode === 401 || response.statusCode === 403) {
			return { pullRequests: [], authenticationRequired: true, error: null };
		}

		let page: BitbucketApiPage;
		try {
			page = JSON.parse(response.body);
		} catch (_) {
			return { pullRequests: [], authenticationRequired: false, error: 'Bitbucket returned an invalid response while loading Pull Requests.' };
		}

		if (response.statusCode < 200 || response.statusCode >= 300) {
			return {
				pullRequests: [],
				authenticationRequired: false,
				error: page.error && (page.error.detail || page.error.message)
					? page.error.detail || page.error.message || 'Unable to load Pull Requests from Bitbucket.'
					: 'Unable to load Pull Requests from Bitbucket (HTTP ' + response.statusCode + ').'
			};
		}

		const values = Array.isArray(page.values) ? page.values : [];
		values.forEach((pullRequest) => {
			const sourceBranch = pullRequest.source && pullRequest.source.branch && pullRequest.source.branch.name;
			const sourceCommit = pullRequest.source && pullRequest.source.commit && pullRequest.source.commit.hash;
			const sourceRepo = pullRequest.source && pullRequest.source.repository && pullRequest.source.repository.full_name;
			const url = pullRequest.links && pullRequest.links.html && pullRequest.links.html.href;
			if (typeof pullRequest.id === 'number' && isPullRequestState(pullRequest.state) && typeof sourceBranch === 'string' && expectedSourceBranches.has(sourceBranch) && typeof sourceCommit === 'string' && sourceCommit !== '' && typeof sourceRepo === 'string' && sourceRepo.toLowerCase() === expectedSourceRepo && typeof url === 'string') {
				const participants = Array.isArray(pullRequest.participants) ? pullRequest.participants : [];
				pullRequests.push({
					id: pullRequest.id,
					sourceBranch: sourceBranch,
					sourceCommit: sourceCommit,
					state: pullRequest.state,
					approvals: participants.filter((participant) => participant.state === 'approved' || participant.approved === true).length,
					changesRequested: participants.filter((participant) => participant.state === 'changes_requested').length,
					title: typeof pullRequest.title === 'string' ? pullRequest.title : '',
					url: url
				});
			}
		});

		nextUrl = typeof page.next === 'string' && isBitbucketApiUrl(page.next) ? page.next : null;
	}

	return { pullRequests: pullRequests, authenticationRequired: false, error: null };
}

function getSourceBranches(branches: ReadonlyArray<string>, sourceRemote: string) {
	const sourceRemotePrefix = 'remotes/' + sourceRemote + '/';
	const sourceBranches = new Set<string>();
	branches.forEach((branch) => {
		if (branch.startsWith('remotes/')) {
			if (branch.startsWith(sourceRemotePrefix)) {
				const branchName = branch.substring(sourceRemotePrefix.length);
				if (branchName !== 'HEAD') sourceBranches.add(branchName);
			}
		} else {
			sourceBranches.add(branch);
		}
	});
	return Array.from(sourceBranches).sort();
}

function getBranchBatches(expectedSourceRepo: string, sourceBranches: ReadonlyArray<string>) {
	const batches: string[][] = [];
	let batch: string[] = [];
	sourceBranches.forEach((branch) => {
		const candidate = batch.concat(branch);
		if (batch.length > 0 && (candidate.length > MAX_BRANCHES_PER_FILTER || encodeURIComponent(getFilter(expectedSourceRepo, candidate)).length > MAX_FILTER_LENGTH)) {
			batches.push(batch);
			batch = [branch];
		} else {
			batch = candidate;
		}
	});
	if (batch.length > 0) batches.push(batch);
	return batches;
}

function getFilter(expectedSourceRepo: string, sourceBranches: ReadonlyArray<string>) {
	return 'source.repository.full_name = ' + JSON.stringify(expectedSourceRepo) + ' AND source.branch.name IN (' + sourceBranches.map((branch) => JSON.stringify(branch)).join(', ') + ')';
}

function isPullRequestState(state: string | undefined): state is BitbucketPullRequest['state'] {
	return state === 'OPEN' || state === 'MERGED' || state === 'DECLINED' || state === 'SUPERSEDED';
}

/**
 * Is a URL the public Bitbucket Cloud host?
 */
export function isBitbucketCloudUrl(url: string) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' && (parsed.hostname === 'bitbucket.org' || parsed.hostname === 'www.bitbucket.org');
	} catch (_) {
		return false;
	}
}

function isBitbucketApiUrl(url: string) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' && parsed.hostname === BITBUCKET_API_HOST;
	} catch (_) {
		return false;
	}
}

function request(url: string, apiToken: string | null): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const headers: { [name: string]: string } = {
			'Accept': 'application/json',
			'User-Agent': 'Git-Graph-VSCode'
		};
		if (apiToken !== null && apiToken !== '') {
			headers.Authorization = 'Bearer ' + apiToken;
		}

		const req = https.get({
			protocol: parsedUrl.protocol,
			hostname: parsedUrl.hostname,
			path: parsedUrl.pathname + parsedUrl.search,
			headers: headers,
			agent: BITBUCKET_HTTPS_AGENT
		}, (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({
				statusCode: response.statusCode || 0,
				body: Buffer.concat(chunks).toString('utf8')
			}));
		});
		req.setTimeout(15000, () => req.destroy(new Error('Timed out while loading Pull Requests from Bitbucket.')));
		req.on('error', reject);
	});
}

function getErrorMessage(err: unknown) {
	return err instanceof Error && err.message !== ''
		? err.message
		: 'Unable to load Pull Requests from Bitbucket.';
}
