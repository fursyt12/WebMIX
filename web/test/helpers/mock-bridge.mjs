/*
 * A stand-in for the bridge the embedded server exposes in `obs --web`, for the
 * browser smoke test.  Only what the smoke test drives is implemented: host
 * detection, the remux queue and the recordings listing the Remux dialog browses.
 *
 * The remux "worker" is a timer that walks a job from 0 to 100% and then marks
 * it complete (or failed when the file name contains "fail"), so the dialog's
 * polling, progress bar and finished message can be exercised without OBS.
 */
import { createServer } from 'node:http';

const DEFAULT_RECORDINGS = [
  { name: 'Recording 2024-01-01 12-00-00.mkv', size: 12_345_678, modified: '2024-01-01T12:00:00' },
  { name: 'Recording 2024-01-02 12-00-00.mp4', size: 23_456_789, modified: '2024-01-02T12:00:00' },
  { name: 'notes.txt', size: 120, modified: '2024-01-02T12:30:00' },
];

/**
 * @param {object} [options]
 * @param {Array<{name: string, size?: number, modified?: string}>} [options.recordings]
 *        files in the recordings root
 * @param {Array<{name: string, size?: number, modified?: string}>} [options.clips]
 *        files in a `clips/` subdirectory, to exercise browsing
 */
export async function startMockBridge({ recordings = DEFAULT_RECORDINGS, clips = [] } = {}) {
  const queue = [];
  let processing = false;
  let progress = 0;
  let timer = null;
  let nextId = 1;

  const all = () => [...recordings, ...clips];

  const state = () => ({
    jobs: queue.map((job) => ({ ...job })),
    processing,
    progress,
    canClearFinished: queue.some((job) => job.state === 'complete'),
    activeCount: queue.filter((job) => job.state === 'pending' || job.state === 'in_progress').length,
  });

  const targetFor = (name, format) => {
    const base = name.replace(/\.[^.]+$/, '');
    if (format === 'mp4' && /\.(mov|mp4)$/i.test(name)) return `${base}.remuxed${name.slice(base.length)}`;
    return `${base}.${format}`;
  };

  /* Walk the queued jobs the way media_remux_job_process would. */
  function startWorker() {
    if (processing) return;
    const next = queue.find((job) => job.state === 'ready');
    if (!next) return;

    processing = true;
    progress = 0;
    next.state = 'in_progress';

    timer = setInterval(() => {
      progress = Math.min(1, progress + 0.34);
      if (progress < 1) return;

      clearInterval(timer);
      timer = null;
      progress = 0;
      next.state = /fail/i.test(next.source) ? 'error' : 'complete';
      if (next.state === 'error') next.error = 'the recording could not be remuxed';
      processing = false;

      /* OBS runs the whole queue in one worker; so does this. */
      if (queue.some((job) => job.state === 'ready')) startWorker();
    }, 260);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(payload);
    };

    if (url.pathname === '/api/status') {
      /* previewStream/propertySchema stay false: the smoke test keeps the
       * obs-websocket preview path it already asserts on. */
      send(200, {
        webmix: true,
        web: true,
        webRoot: '/mock/web',
        version: '33.0.0-mock',
        shutdownEndpoint: true,
        previewStream: false,
        propertySchema: false,
        fileAccess: true,
        remux: true,
      });
      return;
    }

    if (url.pathname === '/api/remux' && req.method === 'GET') {
      send(200, state());
      return;
    }

    if (url.pathname === '/api/remux/add' && req.method === 'POST') {
      const name = url.searchParams.get('path') ?? '';
      const format = url.searchParams.get('format') ?? 'mp4';
      const overwrite = url.searchParams.get('overwrite') === '1';
      const entry = all().find((file) => file.name === name);
      if (!entry) {
        send(400, { ok: false, error: 'not found' });
        return;
      }
      if (!['mp4', 'mov', 'mkv'].includes(format)) {
        send(400, { ok: false, error: 'unsupported target format' });
        return;
      }
      const target = targetFor(name, format);
      if (!overwrite && queue.some((job) => job.target === target)) {
        send(409, { ok: false, conflict: true, error: 'the target file already exists', source: name, target });
        return;
      }
      const job = { id: `job-${nextId++}`, source: name, target, format, state: 'ready' };
      queue.push(job);
      send(200, { ok: true, id: job.id, source: job.source, target: job.target, ...state() });
      return;
    }

    if (url.pathname === '/api/remux/start' && req.method === 'POST') {
      if (!queue.some((job) => job.state === 'ready')) {
        send(400, { ok: false, error: 'there is nothing to remux', ...state() });
        return;
      }
      startWorker();
      send(200, { ok: true, ...state() });
      return;
    }

    if (url.pathname === '/api/remux/stop' && req.method === 'POST') {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const running = queue.find((job) => job.state === 'in_progress');
      if (running) {
        running.state = 'error';
        running.error = 'stopped';
      }
      for (const job of queue) {
        if (job.state === 'pending') job.state = 'ready';
      }
      processing = false;
      progress = 0;
      send(200, { ok: true, ...state() });
      return;
    }

    if (url.pathname === '/api/remux/clear' && req.method === 'POST') {
      for (let index = queue.length - 1; index >= 0; index--) {
        if (queue[index].state === 'complete') queue.splice(index, 1);
      }
      send(200, { ok: true, ...state() });
      return;
    }

    if (url.pathname === '/api/remux/clearall' && req.method === 'POST') {
      queue.length = 0;
      send(200, { ok: true, ...state() });
      return;
    }

    if (url.pathname === '/api/files/list') {
      const kind = url.searchParams.get('kind');
      const relative = url.searchParams.get('path') ?? '';
      if (kind !== 'recordings') {
        send(400, { error: 'that location is not configured' });
        return;
      }
      const entries = relative === 'clips' ? clips : recordings;
      if (relative && relative !== 'clips') {
        send(400, { error: 'not found' });
        return;
      }
      send(200, {
        kind,
        title: 'Recordings',
        path: `/mock/recordings${relative ? `/${relative}` : ''}`,
        root: '/mock/recordings',
        relative,
        parent: relative.includes('/') ? relative.split('/').slice(0, -1).join('/') : '',
        exists: true,
        entries: [
          ...(relative ? [] : [{ name: 'clips', isDirectory: true, size: 0, modified: '2024-01-03T00:00:00' }]),
          ...entries.map((file) => ({
            name: file.name,
            isDirectory: false,
            size: file.size ?? 1024,
            modified: file.modified ?? '2024-01-01T00:00:00',
          })),
        ],
      });
      return;
    }

    send(404, { error: 'unknown endpoint' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    close: () =>
      new Promise((resolve) => {
        if (timer) clearInterval(timer);
        server.close(resolve);
      }),
  };
}
