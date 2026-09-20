import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { runInNewContext } from 'vm';
import { BitbucketPipeline, PullRequestProvider } from '../src/types';

const { JSDOM } = require('jsdom');
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../web/pipelines.ts'), 'utf8'), {
	compilerOptions: { target: ts.ScriptTarget.ES2015 }
}).outputText;

function run(buildNumber: number, status: BitbucketPipeline['status'], group = 'default'): BitbucketPipeline {
	return { uuid: 'run-' + buildNumber, buildNumber: buildNumber, commit: 'a'.repeat(40), name: group, group: group, status: status, createdOn: '2026-09-20T10:00:00Z', url: 'https://bitbucket.org/team/repo/pipelines/results/' + buildNumber };
}

function setup() {
	const dom = new JSDOM('<div id="view"><div id="controls"></div><div id="table"></div></div>', { pretendToBeVisual: true });
	const document = dom.window.document;
	let callback: (entries: any[]) => void = () => {};
	const observed = new Set<any>();
	const sandbox: any = {
		document: document,
		window: { setInterval: jest.fn() },
		IntersectionObserver: class {
			constructor(handler: (entries: any[]) => void) { callback = handler; }
			public observe(element: any) { observed.add(element); }
			public disconnect() { observed.clear(); }
		},
		GG: { PullRequestProvider: { Bitbucket: PullRequestProvider.Bitbucket } },
		sendMessage: jest.fn(),
		handledEvent: (event: any) => { event.preventDefault(); event.stopPropagation(); },
		dialog: { showMessage: jest.fn(), showError: jest.fn() },
		CLASS_EXTERNAL_URL: 'externalUrl',
		abbrevCommit: (hash: string) => hash.slice(0, 8),
		escapeHtml: (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
		SVG_ICONS: { passed: '<svg>passed</svg>', failed: '<svg>failed</svg>', loading: '<svg>loading</svg>', close: '<svg>close</svg>', inconclusive: '<svg>inconclusive</svg>' }
	};
	runInNewContext(source + '\nthis.View = PipelineView;', sandbox);
	const table = document.getElementById('table');
	const view = new sandbox.View(table, document.getElementById('view'));
	const config = { provider: PullRequestProvider.Bitbucket, hostRootUrl: 'https://bitbucket.org', sourceOwner: 'team', sourceRepo: 'repo' };
	view.setRepository('/repo', config);
	const addRows = (count: number) => {
		table.innerHTML = Array.from({ length: count }, (_, index) => '<div class="commit"><span data-pipeline-commit="' + index.toString(16).padStart(40, '0') + '"></span></div>').join('');
		view.observeRows();
	};
	const enter = () => callback(Array.from(observed).map((target) => ({ target: target, isIntersecting: true })));
	const respond = (request: any, pipelines: BitbucketPipeline[] = []) => view.processResponse({ ...request, pipelines: pipelines, authenticationRequired: false, error: null });
	return { sandbox, view, document, table, config, addRows, enter, respond, dom };
}

it('summarizes the newest run per pipeline and preserves independent failures and running runs', () => {
	const { sandbox, dom } = setup();
	const runs = [run(1, 'failed'), run(2, 'passed'), run(3, 'failed', 'deploy'), run(4, 'running', 'tests')];
	const badge = sandbox.pipelineBadgeHtml(runs);
	expect(badge).toContain('commitPipelineBadge failed');
	expect(badge).toContain('pipelineState running');
	expect(badge).toContain('CI 3');
	expect(badge).not.toContain('#1 ');
	expect(sandbox.pipelineBadgeHtml(runs.slice(0, 2))).toContain('commitPipelineBadge passed');
	expect(sandbox.pipelineBadgeHtml([])).toBe('');
	dom.window.close();
});

it('escapes untrusted pipeline names in badge HTML', () => {
	const { sandbox, dom } = setup();
	const badge = sandbox.pipelineBadgeHtml([run(1, 'passed', '"><img src=x onerror=alert(1)>')]);
	expect(badge).not.toContain('<img');
	expect(badge).toContain('&lt;img');
	dom.window.close();
});

it('loads only visible rows and limits concurrency to four requests', () => {
	const { sandbox, addRows, enter, respond, dom } = setup();
	addRows(10);
	expect(sandbox.sendMessage).not.toHaveBeenCalled();
	enter();
	expect(sandbox.sendMessage).toHaveBeenCalledTimes(4);
	respond(sandbox.sendMessage.mock.calls[0][0]);
	expect(sandbox.sendMessage).toHaveBeenCalledTimes(5);
	dom.window.close();
});

it('shows all runs in the dialog and stops badge clicks from opening commit details', () => {
	const { sandbox, addRows, enter, respond, table, dom } = setup();
	addRows(1);
	enter();
	respond(sandbox.sendMessage.mock.calls[0][0], [run(2, 'passed'), run(1, 'failed')]);
	const click = jest.fn();
	table.addEventListener('click', click);
	table.querySelector('button').click();
	expect(click).not.toHaveBeenCalled();
	const html = sandbox.dialog.showMessage.mock.calls[0][0];
	expect(html).toContain('/results/1');
	expect(html).toContain('/results/2');
	expect(html).toContain('Earlier run');
	expect(html).toContain('Latest run');
	dom.window.close();
});

it('ignores responses from an earlier repository or refresh generation', () => {
	const { sandbox, view, config, addRows, enter, respond, table, dom } = setup();
	addRows(1);
	enter();
	const old = sandbox.sendMessage.mock.calls[0][0];
	view.setRepository('/other', config);
	respond(old, [run(1, 'passed')]);
	expect(table.querySelector('button')).toBeNull();
	view.setRepository('/repo', config);
	respond(old, [run(1, 'passed')]);
	expect(table.querySelector('button')).toBeNull();
	dom.window.close();
});

it('stops loading after an authentication error and recovers after refresh', () => {
	const { sandbox, view, document, addRows, enter, respond, dom } = setup();
	addRows(8);
	enter();
	const request = sandbox.sendMessage.mock.calls[0][0];
	view.processResponse({ ...request, pipelines: [], authenticationRequired: true, error: null });
	respond(sandbox.sendMessage.mock.calls[1][0]);
	expect(sandbox.sendMessage).toHaveBeenCalledTimes(4);
	document.querySelector('.pipelineNotice').click();
	expect(sandbox.sendMessage).toHaveBeenLastCalledWith({ command: 'setBitbucketApiToken' });
	view.refresh();
	enter();
	expect(document.querySelector('.pipelineNotice')).toBeNull();
	expect(sandbox.sendMessage.mock.calls[5][0].force).toBe(true);
	dom.window.close();
});

it('does not request pipelines for unsupported hosts or providers', () => {
	const { sandbox, view, config, addRows, enter, dom } = setup();
	view.setRepository('/repo', { ...config, provider: PullRequestProvider.GitHub });
	addRows(1);
	enter();
	view.setRepository('/repo', { ...config, hostRootUrl: 'https://bitbucket.example.com' });
	enter();
	expect(sandbox.sendMessage).not.toHaveBeenCalled();
	dom.window.close();
});
