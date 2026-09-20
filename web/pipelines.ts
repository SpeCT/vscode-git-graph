/** Pipeline data is loaded only for visible commits, with up to four requests at once. */
class PipelineView {
	private repo = '';
	private config: GG.PullRequestConfig | null = null;
	private queryKey = '';
	private generation = 0;
	private readonly data = new Map<string, { pipelines: GG.BitbucketPipeline[]; expiresAt: number }>();
	private readonly pending = new Set<string>();
	private readonly visible = new Set<string>();
	private readonly observer: IntersectionObserver;
	private error: string | null = null;
	private authenticationRequired = false;
	private force = false;

	constructor(private readonly table: HTMLElement, root: HTMLElement) {
		this.observer = new IntersectionObserver((entries) => {
			entries.forEach((entry) => {
				const slot = entry.target.querySelector<HTMLElement>('[data-pipeline-commit]');
				if (!slot || !this.table.contains(entry.target)) return;
				const hash = slot.dataset.pipelineCommit!;
				if (entry.isIntersecting) this.visible.add(hash);
				else this.visible.delete(hash);
			});
			this.loadVisible();
		}, { root: root, rootMargin: '100px 0px' });
		const status = document.createElement('span');
		status.id = 'pipelineStatus';
		document.getElementById('controls')!.appendChild(status);
		window.setInterval(() => this.loadVisible(), 5000);
		document.addEventListener('visibilitychange', () => this.loadVisible());
	}

	public setRepository(repo: string, config: GG.PullRequestConfig | null) {
		if (config !== null && (config.provider !== GG.PullRequestProvider.Bitbucket || !/^https:\/\/(www\.)?bitbucket\.org\/?$/i.test(config.hostRootUrl))) config = null;
		const key = JSON.stringify([repo, config && config.hostRootUrl, config && config.sourceOwner, config && config.sourceRepo]);
		if (key === this.queryKey) return;
		this.repo = repo;
		this.config = config;
		this.queryKey = key;
		this.reset(false);
	}

	public refresh() {
		this.reset(true);
	}

	private reset(force: boolean) {
		this.generation++;
		this.data.clear();
		this.pending.clear();
		this.error = null;
		this.authenticationRequired = false;
		this.force = force;
		this.observeRows();
	}

	public observeRows() {
		this.observer.disconnect();
		this.visible.clear();
		this.table.querySelectorAll<HTMLElement>('[data-pipeline-commit]').forEach((slot) => {
			this.renderSlot(slot);
			if (this.config !== null) this.observer.observe(slot.closest('.commit')!);
		});
		this.renderStatus();
	}

	private loadVisible() {
		if (this.config === null || document.hidden || this.error !== null || this.authenticationRequired) return;
		this.visible.forEach((commit) => {
			const cached = this.data.get(commit);
			if (this.pending.size >= 4 || this.pending.has(commit) || (cached && cached.expiresAt > Date.now())) return;
			this.pending.add(commit);
			sendMessage({ command: 'loadPipelines', repo: this.repo, config: this.config!, commit: commit, refreshId: this.generation, force: this.force });
		});
	}

	public processResponse(msg: GG.ResponseLoadPipelines) {
		if (msg.repo !== this.repo || msg.refreshId !== this.generation) return;
		this.pending.delete(msg.commit);
		if (msg.authenticationRequired || msg.error !== null) {
			this.authenticationRequired = this.authenticationRequired || msg.authenticationRequired;
			this.error = msg.error || this.error;
			this.renderStatus();
		} else {
			const active = msg.pipelines.some((pipeline) => pipeline.status === 'running' || pipeline.status === 'pending' || pipeline.status === 'paused');
			this.data.set(msg.commit, { pipelines: msg.pipelines, expiresAt: Date.now() + (active ? 30000 : 120000) });
			this.table.querySelectorAll<HTMLElement>('[data-pipeline-commit="' + msg.commit + '"]').forEach((slot) => this.renderSlot(slot));
		}
		this.loadVisible();
	}

	private renderSlot(slot: HTMLElement) {
		const entry = this.data.get(slot.dataset.pipelineCommit!);
		slot.innerHTML = entry ? pipelineBadgeHtml(entry.pipelines) : '';
		const button = slot.querySelector('button');
		if (button) button.addEventListener('click', (event) => {
			handledEvent(event);
			this.showRuns(slot.dataset.pipelineCommit!);
		});
	}

	private renderStatus() {
		const status = document.getElementById('pipelineStatus');
		if (!status) return;
		status.innerHTML = '';
		if (this.config === null || (!this.authenticationRequired && this.error === null)) return;
		const button = document.createElement('button');
		button.className = 'pipelineNotice';
		button.textContent = this.authenticationRequired ? 'Pipelines: authentication required' : 'Pipelines unavailable';
		button.title = this.authenticationRequired ? 'Set a Bitbucket token with Pipelines: Read permission.' : this.error!;
		button.addEventListener('click', () => {
			if (this.authenticationRequired) sendMessage({ command: 'setBitbucketApiToken' });
			else dialog.showError('Unable to load Bitbucket Pipelines', this.error, 'Retry', () => this.refresh());
		});
		status.appendChild(button);
	}

	private showRuns(commit: string) {
		const entry = this.data.get(commit);
		if (!entry) return;
		const latest = new Set(latestPipelines(entry.pipelines).map((pipeline) => pipeline.uuid));
		dialog.showMessage('<b>Bitbucket Pipelines</b> · ' + escapeHtml(abbrevCommit(commit)) +
			'<div class="pipelineRuns">' + entry.pipelines.map((pipeline) =>
			'<div class="pipelineRun"><span class="pipelineState ' + pipeline.status + '">' + pipelineStatusIcon(pipeline.status) + ' ' + pipeline.status + '</span> ' +
				'<a class="' + CLASS_EXTERNAL_URL + '" href="' + escapeHtml(pipeline.url) + '">#' + pipeline.buildNumber + ' · ' + escapeHtml(pipeline.name) + '</a>' +
				'<div class="pipelineRunDate">' + escapeHtml(pipelineDate(pipeline.createdOn)) + (latest.has(pipeline.uuid) ? ' · Latest run' : ' · Earlier run') + '</div></div>'
		).join('') + '</div>');
		document.querySelectorAll('.pipelineRuns a').forEach((link) => link.addEventListener('keydown', (event) => {
			if ((<KeyboardEvent>event).key === 'Enter') event.stopPropagation();
		}));
	}
}

function latestPipelines(pipelines: ReadonlyArray<GG.BitbucketPipeline>): GG.BitbucketPipeline[] {
	const latest = new Map<string, GG.BitbucketPipeline>();
	pipelines.forEach((pipeline) => {
		const previous = latest.get(pipeline.group);
		if (!previous || pipeline.buildNumber > previous.buildNumber) latest.set(pipeline.group, pipeline);
	});
	return Array.from(latest.values());
}

function pipelineBadgeHtml(pipelines: ReadonlyArray<GG.BitbucketPipeline>) {
	const latest = latestPipelines(pipelines);
	if (latest.length === 0) return '';
	const priority: GG.BitbucketPipelineStatus[] = ['failed', 'running', 'paused', 'pending', 'stopped', 'unknown', 'passed'];
	const status = priority.find((state) => latest.some((pipeline) => pipeline.status === state))!;
	const running = status !== 'running' && latest.some((pipeline) => pipeline.status === 'running');
	const title = 'Bitbucket Pipelines — click to view all runs\n' + latest.map((pipeline) => '#' + pipeline.buildNumber + ' ' + pipeline.name + ': ' + pipeline.status + ' · ' + pipelineDate(pipeline.createdOn)).join('\n');
	return '<button type="button" class="commitPipelineBadge ' + status + '" title="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '">' +
		pipelineStatusIcon(status) + (running ? '<span class="pipelineState running">' + pipelineStatusIcon('running') + '</span>' : '') +
		'<span>CI' + (latest.length > 1 ? ' ' + latest.length : '') + '</span></button>';
}

function pipelineStatusIcon(status: GG.BitbucketPipelineStatus) {
	if (status === 'pending') return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM7.25 4v4.5l3 2 .85-1.25-2.35-1.5V4z"/></svg>';
	if (status === 'paused') return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zm5 0h3v10H9z"/></svg>';
	return status === 'passed' ? SVG_ICONS.passed : status === 'failed' ? SVG_ICONS.failed : status === 'running' ? SVG_ICONS.loading : status === 'stopped' ? SVG_ICONS.close : SVG_ICONS.inconclusive;
}

function pipelineDate(value: string) {
	const date = new Date(value);
	return isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString();
}
