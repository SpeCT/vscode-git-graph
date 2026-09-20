import { createHash } from 'crypto';
import * as https from 'https';
import { URL } from 'url';
import { isBitbucketCloudUrl } from './bitbucketPullRequests';
import { BitbucketPipeline, BitbucketPipelineStatus, ErrorInfo, PullRequestConfig, PullRequestProvider } from './types';

interface PipelineResult {
	readonly pipelines: BitbucketPipeline[];
	readonly authenticationRequired: boolean;
	readonly error: ErrorInfo;
}

interface ApiPipeline {
	uuid?: string;
	build_number?: number;
	created_on?: string;
	state?: { name?: string; result?: { name?: string }; stage?: { name?: string } };
	target?: {
		type?: string;
		commit?: { hash?: string };
		ref_type?: string;
		ref_name?: string;
		source?: string;
		destination?: string;
		pullrequest?: { id?: number };
		selector?: { type?: string; pattern?: string };
	};
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
const cache = new Map<string, { expiresAt: number; result: PipelineResult }>();
const inFlight = new Map<string, Promise<PipelineResult>>();
let generation = 0;

export function clearBitbucketPipelineCache() {
	generation++;
	cache.clear();
	inFlight.clear();
}

/** Fetch runs by exact commit, independently of branch labels and PR destinations. */
export function getBitbucketPipelines(config: PullRequestConfig, token: string | null, commit: string, force: boolean = false): Promise<PipelineResult> {
	if (config.provider !== PullRequestProvider.Bitbucket || !isBitbucketCloudUrl(config.hostRootUrl) || !/^[a-f0-9]{40}$/i.test(commit)) {
		return Promise.resolve({ pipelines: [], authenticationRequired: false, error: null });
	}
	commit = commit.toLowerCase();
	const key = JSON.stringify([config.sourceOwner.toLowerCase(), config.sourceRepo.toLowerCase(), commit, createHash('sha256').update(token || '').digest('hex')]);
	const pending = inFlight.get(key);
	if (pending) return pending;
	const cached = cache.get(key);
	if (!force && cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
	const requestGeneration = generation;
	const promise = loadPipelines(config, token, commit).then((result) => {
		if (generation === requestGeneration) {
			inFlight.delete(key);
			if (result.error === null && !result.authenticationRequired) {
				cache.delete(key);
				while (cache.size >= 500) cache.delete(cache.keys().next().value!);
				const active = result.pipelines.some((pipeline) => pipeline.status === 'running' || pipeline.status === 'pending' || pipeline.status === 'paused');
				cache.set(key, { result: result, expiresAt: Date.now() + (active ? 30000 : 120000) });
			}
		}
		return result;
	});
	inFlight.set(key, promise);
	return promise;
}

async function loadPipelines(config: PullRequestConfig, token: string | null, commit: string): Promise<PipelineResult> {
	const path = '/2.0/repositories/' + encodeURIComponent(config.sourceOwner) + '/' + encodeURIComponent(config.sourceRepo) + '/pipelines/';
	let next: string | null = 'https://api.bitbucket.org' + path + '?pagelen=50&sort=-created_on&target.commit.hash=' + commit;
	const visited = new Set<string>();
	const pipelines = new Map<string, BitbucketPipeline>();
	try {
		while (next !== null) {
			const url = new URL(next);
			if (url.origin !== 'https://api.bitbucket.org' || url.username !== '' || url.password !== '' || url.pathname.replace(/\/$/, '') !== path.replace(/\/$/, '') || visited.has(next) || visited.size >= 200) {
				throw new Error('Bitbucket returned an invalid pipeline pagination link.');
			}
			visited.add(next);
			const response = await request(url, token);
			if (response.status === 401 || response.status === 403) return { pipelines: [], authenticationRequired: true, error: null };
			if (response.status === 429) throw new Error('Bitbucket rate limit reached. Wait a moment, then refresh Pipelines.');
			if (response.status < 200 || response.status >= 300) throw new Error('Unable to load Bitbucket Pipelines (HTTP ' + response.status + ').');
			const page = JSON.parse(response.body);
			if (!page || !Array.isArray(page.values)) throw new Error('Bitbucket returned an invalid pipeline response.');
			page.values.forEach((value: ApiPipeline | null) => {
				if (!value || typeof value.uuid !== 'string' || !Number.isSafeInteger(value.build_number) || value.build_number! < 1 || !value.target || !value.target.commit || typeof value.target.commit.hash !== 'string' || value.target.commit.hash.toLowerCase() !== commit) return;
				const target = value.target;
				const selector = target.selector || {};
				const ref = target.ref_name || target.source || '';
				pipelines.set(value.uuid, {
					uuid: value.uuid,
					buildNumber: value.build_number!,
					commit: commit,
					name: [selector.pattern || selector.type || 'Pipeline', ref, target.pullrequest ? 'PR #' + target.pullrequest.id : ''].filter(Boolean).join(' · '),
					group: JSON.stringify([target.type, target.ref_type, ref, target.destination, target.pullrequest && target.pullrequest.id, selector.type, selector.pattern]),
					status: pipelineStatus(value.state),
					createdOn: typeof value.created_on === 'string' ? value.created_on : '',
					url: 'https://bitbucket.org/' + encodeURIComponent(config.sourceOwner) + '/' + encodeURIComponent(config.sourceRepo) + '/pipelines/results/' + value.build_number
				});
			});
			next = typeof page.next === 'string' && page.next !== '' ? page.next : null;
		}
		return { pipelines: Array.from(pipelines.values()).sort((a, b) => b.buildNumber - a.buildNumber), authenticationRequired: false, error: null };
	} catch (err) {
		return { pipelines: [], authenticationRequired: false, error: err instanceof Error ? err.message : 'Unable to load Bitbucket Pipelines.' };
	}
}

function pipelineStatus(state: ApiPipeline['state']): BitbucketPipelineStatus {
	if (!state) return 'unknown';
	if (state.name === 'PENDING') return 'pending';
	if (state.name === 'IN_PROGRESS') return state.stage && state.stage.name === 'PAUSED' ? 'paused' : 'running';
	if (state.name === 'COMPLETED' && state.result) {
		switch (state.result.name) {
			case 'SUCCESSFUL': return 'passed';
			case 'FAILED':
			case 'ERROR':
			case 'EXPIRED': return 'failed';
			case 'STOPPED': return 'stopped';
		}
	}
	return 'unknown';
}

function request(url: URL, token: string | null): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const headers: { [key: string]: string } = { Accept: 'application/json', 'User-Agent': 'Git-Graph-VSCode' };
		if (token) headers.Authorization = 'Bearer ' + token;
		const req = https.get({ protocol: url.protocol, hostname: url.hostname, path: url.pathname + url.search, headers: headers, agent: agent }, (response) => {
			const chunks: Buffer[] = [];
			let bytes = 0;
			response.on('data', (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > 5 * 1024 * 1024) req.destroy(new Error('Bitbucket pipeline response is too large.'));
				else chunks.push(chunk);
			});
			response.on('error', reject);
			response.on('aborted', () => reject(new Error('Bitbucket pipeline response was interrupted.')));
			response.on('end', () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
		});
		req.setTimeout(15000, () => req.destroy(new Error('Timed out loading Bitbucket Pipelines.')));
		req.on('error', reject);
	});
}
