jest.mock('https');

import { EventEmitter } from 'events';
import * as https from 'https';
import { clearBitbucketPipelineCache, getBitbucketPipelines } from '../src/bitbucketPipelines';
import { PullRequestConfig, PullRequestProvider } from '../src/types';

const commit = 'a'.repeat(40);
const config: PullRequestConfig = {
	provider: PullRequestProvider.Bitbucket, custom: null, hostRootUrl: 'https://bitbucket.org',
	sourceRemote: 'origin', sourceOwner: 'source-workspace', sourceRepo: 'source-repo',
	destRemote: 'upstream', destOwner: 'destination-workspace', destRepo: 'destination-repo', destProjectId: '', destBranch: 'main'
};
const next = 'https://api.bitbucket.org/2.0/repositories/source-workspace/source-repo/pipelines/?page=2';

function pipeline(build: number, state: object = { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } }) {
	return {
		uuid: '{run-' + build + '}', build_number: build, created_on: '2026-09-19T10:00:00Z', state: state,
		target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'main', commit: { hash: commit }, selector: { type: 'branches', pattern: 'main' } }
	};
}

function mockResponses(pages: Array<{ status: number; body: unknown }>) {
	(<jest.Mock>https.get).mockImplementation((_: any, callback: (response: EventEmitter & { statusCode: number }) => void) => {
		const page = pages.shift()!;
		const response = <EventEmitter & { statusCode: number }>new EventEmitter();
		response.statusCode = page.status;
		process.nextTick(() => {
			callback(response);
			response.emit('data', Buffer.from(typeof page.body === 'string' ? page.body : JSON.stringify(page.body)));
			response.emit('end');
		});
		return { setTimeout: jest.fn(), destroy: jest.fn(), on: jest.fn() };
	});
}

beforeEach(() => {
	clearBitbucketPipelineCache();
	jest.resetAllMocks();
});
afterEach(() => jest.restoreAllMocks());

it('loads every page from the source repository, matches exact commits and preserves reruns', async () => {
	const other = pipeline(99);
	other.target.commit.hash = 'b'.repeat(40);
	mockResponses([
		{ status: 200, body: { values: [pipeline(2), other, null, {}], next: next } },
		{ status: 200, body: { values: [pipeline(1), pipeline(2)] } }
	]);
	const result = await getBitbucketPipelines(config, 'secret', commit);
	expect(result.error).toBeNull();
	expect(result.pipelines.map((run) => run.buildNumber)).toEqual([2, 1]);
	expect(result.pipelines[0]).toMatchObject({ commit: commit, status: 'passed', url: 'https://bitbucket.org/source-workspace/source-repo/pipelines/results/2' });
	const options = (<jest.Mock>https.get).mock.calls[0][0];
	expect(options.path).toContain('/source-workspace/source-repo/pipelines/');
	expect(options.path).toContain('target.commit.hash=' + commit);
	expect(options.headers.Authorization).toBe('Bearer secret');
});

it.each([
	[{ name: 'PENDING' }, 'pending'],
	[{ name: 'IN_PROGRESS' }, 'running'],
	[{ name: 'IN_PROGRESS', stage: { name: 'PAUSED' } }, 'paused'],
	[{ name: 'COMPLETED', result: { name: 'SUCCESSFUL' } }, 'passed'],
	[{ name: 'COMPLETED', result: { name: 'FAILED' } }, 'failed'],
	[{ name: 'COMPLETED', result: { name: 'ERROR' } }, 'failed'],
	[{ name: 'COMPLETED', result: { name: 'EXPIRED' } }, 'failed'],
	[{ name: 'COMPLETED', result: { name: 'STOPPED' } }, 'stopped'],
	[{ name: 'COMPLETED', result: { name: 'NEW_RESULT' } }, 'unknown']
])('maps pipeline state %j to %s', async (state, expected) => {
	mockResponses([{ status: 200, body: { values: [pipeline(1, <object>state)] } }]);
	expect((await getBitbucketPipelines(config, null, commit)).pipelines[0].status).toBe(expected);
});

it('keeps branches, custom pipelines and PR targets in separate groups', async () => {
	const branch = pipeline(1), custom = pipeline(2), anotherBranch = pipeline(3);
	custom.target.selector = { type: 'custom', pattern: 'deploy' };
	anotherBranch.target.ref_name = 'release';
	mockResponses([{ status: 200, body: { values: [branch, custom, anotherBranch, { ...pipeline(4), target: { type: 'pipeline_pullrequest_target', source: 'main', destination: 'release', pullrequest: { id: 5 }, commit: { hash: commit } } }] } }]);
	const runs = (await getBitbucketPipelines(config, null, commit)).pipelines;
	expect(new Set(runs.map((run) => run.group)).size).toBe(4);
	expect(runs[0].name).toContain('PR #5');
});

it('deduplicates requests, caches results and isolates credentials', async () => {
	mockResponses(new Array(3).fill({ status: 200, body: { values: [] } }));
	await Promise.all([getBitbucketPipelines(config, 'first', commit), getBitbucketPipelines(config, 'first', commit)]);
	await getBitbucketPipelines(config, 'first', commit);
	expect(https.get).toHaveBeenCalledTimes(1);
	await getBitbucketPipelines(config, 'second', commit);
	await getBitbucketPipelines(config, 'second', commit, true);
	expect(https.get).toHaveBeenCalledTimes(3);
});

it('expires active runs after thirty seconds and completed runs after two minutes', async () => {
	let now = 1000;
	jest.spyOn(Date, 'now').mockImplementation(() => now);
	mockResponses([
		{ status: 200, body: { values: [pipeline(1, { name: 'IN_PROGRESS' })] } },
		{ status: 200, body: { values: [pipeline(1)] } },
		{ status: 200, body: { values: [] } }
	]);
	await getBitbucketPipelines(config, null, commit);
	now += 30001;
	await getBitbucketPipelines(config, null, commit);
	now += 31000;
	await getBitbucketPipelines(config, null, commit);
	expect(https.get).toHaveBeenCalledTimes(2);
	now += 90000;
	await getBitbucketPipelines(config, null, commit);
	expect(https.get).toHaveBeenCalledTimes(3);
});

it('does not repopulate the cache from requests completed after token invalidation', async () => {
	mockResponses(new Array(2).fill({ status: 200, body: { values: [] } }));
	const pending = getBitbucketPipelines(config, 'token', commit);
	clearBitbucketPipelineCache();
	await pending;
	await getBitbucketPipelines(config, 'token', commit);
	expect(https.get).toHaveBeenCalledTimes(2);
});

it.each([401, 403])('reports missing authentication or scopes for HTTP %s', async (status) => {
	mockResponses([{ status: status, body: {} }]);
	expect(await getBitbucketPipelines(config, null, commit)).toEqual({ pipelines: [], authenticationRequired: true, error: null });
});

it.each([429, 500])('reports HTTP %s without caching a missing pipeline', async (status) => {
	mockResponses([{ status: status, body: {} }, { status: 200, body: { values: [] } }]);
	expect((await getBitbucketPipelines(config, null, commit)).error).not.toBeNull();
	expect((await getBitbucketPipelines(config, null, commit)).error).toBeNull();
});

it.each(['not json', 'null', '{}'])('rejects malformed responses: %s', async (body) => {
	mockResponses([{ status: 200, body: body }]);
	expect((await getBitbucketPipelines(config, null, commit)).error).not.toBeNull();
});

it.each(['https://evil.example/pipelines/', 'http://api.bitbucket.org/2.0/repositories/source-workspace/source-repo/pipelines/', 'https://api.bitbucket.org/2.0/repositories/another/repo/pipelines/'])('never sends the token to an unexpected pagination URL: %s', async (url) => {
	mockResponses([{ status: 200, body: { values: [], next: url } }]);
	expect((await getBitbucketPipelines(config, 'secret', commit)).error).toContain('pagination');
	expect(https.get).toHaveBeenCalledTimes(1);
});

it('detects pagination loops', async () => {
	mockResponses(new Array(2).fill({ status: 200, body: { values: [], next: next } }));
	expect((await getBitbucketPipelines(config, null, commit)).error).toContain('pagination');
	expect(https.get).toHaveBeenCalledTimes(2);
});

it('skips unsupported repositories and non-commit rows', async () => {
	await getBitbucketPipelines({ ...config, hostRootUrl: 'https://bitbucket.example.com' }, null, commit);
	await getBitbucketPipelines({ ...config, provider: PullRequestProvider.GitHub }, null, commit);
	await getBitbucketPipelines(config, null, 'uncommitted');
	expect(https.get).not.toHaveBeenCalled();
});
