jest.mock('https');

import { EventEmitter } from 'events';
import * as https from 'https';
import { clearBitbucketPullRequestCache, getBitbucketPullRequests, isBitbucketCloudUrl } from '../src/bitbucketPullRequests';
import { PullRequestConfig, PullRequestProvider } from '../src/types';

const config: PullRequestConfig = {
	provider: PullRequestProvider.Bitbucket,
	custom: null,
	hostRootUrl: 'https://bitbucket.org',
	sourceRemote: 'origin',
	sourceOwner: 'source-workspace',
	sourceRepo: 'source-repo',
	destRemote: 'origin',
	destOwner: 'destination-workspace',
	destRepo: 'destination-repo',
	destProjectId: '',
	destBranch: 'main'
};

describe('Bitbucket Pull Requests', () => {
	afterEach(() => {
		clearBitbucketPullRequestCache();
		jest.resetAllMocks();
	});

	it('Should identify Bitbucket Cloud URLs', () => {
		expect(isBitbucketCloudUrl('https://bitbucket.org')).toBe(true);
		expect(isBitbucketCloudUrl('https://www.bitbucket.org/')).toBe(true);
		expect(isBitbucketCloudUrl('http://bitbucket.org')).toBe(false);
		expect(isBitbucketCloudUrl('https://bitbucket.example.com')).toBe(false);
		expect(isBitbucketCloudUrl('invalid')).toBe(false);
	});

	it('Should load and filter Pull Requests in every state', async () => {
		mockHttpsResponses([{
			statusCode: 200,
			body: JSON.stringify({
				values: [{
					id: 123,
					state: 'OPEN',
					title: 'Feature PR',
					participants: [{ state: 'approved', approved: true }, { state: 'changes_requested', approved: false }],
					source: { branch: { name: 'feature/test' }, commit: { hash: '1111111' }, repository: { full_name: 'source-workspace/source-repo' } },
					links: { html: { href: 'https://bitbucket.org/destination-workspace/destination-repo/pull-requests/123' } }
				}, {
					id: 124,
					state: 'MERGED',
					title: 'Merged feature PR',
					participants: [{ state: 'approved', approved: true }],
					source: { branch: { name: 'feature/merged' }, commit: { hash: '2222222' }, repository: { full_name: 'source-workspace/source-repo' } },
					links: { html: { href: 'https://bitbucket.org/destination-workspace/destination-repo/pull-requests/124' } }
				}, {
					id: 125,
					state: 'DECLINED',
					title: 'Declined feature PR',
					source: { branch: { name: 'feature/declined' }, commit: { hash: '3333333' }, repository: { full_name: 'source-workspace/source-repo' } },
					links: { html: { href: 'https://bitbucket.org/destination-workspace/destination-repo/pull-requests/125' } }
				}, {
					id: 126,
					state: 'SUPERSEDED',
					title: 'Superseded feature PR',
					source: { branch: { name: 'feature/superseded' }, commit: { hash: '4444444' }, repository: { full_name: 'source-workspace/source-repo' } },
					links: { html: { href: 'https://bitbucket.org/destination-workspace/destination-repo/pull-requests/126' } }
				}, {
					id: 127,
					state: 'OPEN',
					title: 'PR from another fork',
					source: { branch: { name: 'feature/test' }, commit: { hash: '5555555' }, repository: { full_name: 'someone-else/source-repo' } },
					links: { html: { href: 'https://bitbucket.org/destination-workspace/destination-repo/pull-requests/127' } }
				}, {
					id: 128,
					state: 'OPEN',
					title: 'PR for an unrelated branch',
					source: { branch: { name: 'feature/unrelated' }, commit: { hash: '6666666' }, repository: { full_name: 'source-workspace/source-repo' } },
					links: { html: { href: 'https://bitbucket.org/destination-workspace/destination-repo/pull-requests/128' } }
				}]
			})
		}]);

		const result = await getBitbucketPullRequests(config, 'secret-token', [
			'feature/test', 'feature/merged', 'feature/declined', 'feature/superseded',
			'remotes/origin/feature/test', 'remotes/origin/HEAD', 'remotes/other/feature/unrelated'
		]);

		expect(result).toStrictEqual({
			pullRequests: [{
				id: 123,
				sourceBranch: 'feature/test',
				sourceCommit: '1111111',
				state: 'OPEN',
				approvals: 1,
				changesRequested: 1,
				title: 'Feature PR',
				url: 'https://bitbucket.org/destination-workspace/destination-repo/pull-requests/123'
			}, {
				id: 124,
				sourceBranch: 'feature/merged',
				sourceCommit: '2222222',
				state: 'MERGED',
				approvals: 1,
				changesRequested: 0,
				title: 'Merged feature PR',
				url: 'https://bitbucket.org/destination-workspace/destination-repo/pull-requests/124'
			}, {
				id: 125,
				sourceBranch: 'feature/declined',
				sourceCommit: '3333333',
				state: 'DECLINED',
				approvals: 0,
				changesRequested: 0,
				title: 'Declined feature PR',
				url: 'https://bitbucket.org/destination-workspace/destination-repo/pull-requests/125'
			}, {
				id: 126,
				sourceBranch: 'feature/superseded',
				sourceCommit: '4444444',
				state: 'SUPERSEDED',
				approvals: 0,
				changesRequested: 0,
				title: 'Superseded feature PR',
				url: 'https://bitbucket.org/destination-workspace/destination-repo/pull-requests/126'
			}],
			authenticationRequired: false,
			error: null
		});
		expect(https.get).toHaveBeenCalledWith(expect.objectContaining({
			hostname: 'api.bitbucket.org',
			path: expect.stringContaining('state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED'),
			headers: expect.objectContaining({ Authorization: 'Bearer secret-token' })
		}), expect.anything());
		const requestPath = (<jest.Mock>https.get).mock.calls[0][0].path;
		expect(requestPath).toContain('pagelen=50');
		expect(requestPath).toContain('values.source.commit.hash');
		expect(decodeURIComponent(requestPath)).toContain('source.repository.full_name = "source-workspace/source-repo"');
		expect(decodeURIComponent(requestPath)).toContain('source.branch.name IN ("feature/declined", "feature/merged", "feature/superseded", "feature/test")');
	});

	it('Should cache Pull Requests and deduplicate identical requests', async () => {
		mockHttpsResponses([{
			statusCode: 200,
			body: JSON.stringify({ values: [] })
		}]);

		const requests = [
			getBitbucketPullRequests(config, 'secret-token', ['feature/test']),
			getBitbucketPullRequests(config, 'secret-token', ['feature/test'])
		];
		await expect(Promise.all(requests)).resolves.toStrictEqual([
			{ pullRequests: [], authenticationRequired: false, error: null },
			{ pullRequests: [], authenticationRequired: false, error: null }
		]);
		await expect(getBitbucketPullRequests(config, 'secret-token', ['feature/test'])).resolves.toStrictEqual({
			pullRequests: [], authenticationRequired: false, error: null
		});
		expect(https.get).toHaveBeenCalledTimes(1);
	});

	it('Should report when authentication is required', async () => {
		mockHttpsResponses([{ statusCode: 401, body: '{}' }]);

		await expect(getBitbucketPullRequests(config, null, ['feature/test'])).resolves.toStrictEqual({
			pullRequests: [],
			authenticationRequired: true,
			error: null
		});
	});
});

function mockHttpsResponses(responses: Array<{ statusCode: number, body: string }>) {
	(<jest.Mock>https.get).mockImplementation((_: any, callback: (response: EventEmitter & { statusCode: number }) => void) => {
		const responseData = responses.shift()!;
		const response = <EventEmitter & { statusCode: number }>new EventEmitter();
		response.statusCode = responseData.statusCode;
		process.nextTick(() => {
			callback(response);
			response.emit('data', Buffer.from(responseData.body));
			response.emit('end');
		});
		return {
			setTimeout: jest.fn(),
			destroy: jest.fn(),
			on: jest.fn()
		};
	});
}
