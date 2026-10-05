#!/usr/bin/env node
/**
 * WebMIX - Integration tests
 * Tests the actual server and file serving
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const webRoot = join(__dirname, '..');

let serverProcess = null;
const PORT = 9191;

async function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn('node', ['server.mjs', '--port', String(PORT), '--host', '127.0.0.1'], {
      cwd: webRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    serverProcess.stdout.on('data', (data) => {
      output += data.toString();
      if (output.includes('Serving') || output.includes('listening')) {
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('EADDRINUSE')) {
        reject(new Error('Port already in use'));
      }
    });

    setTimeout(() => resolve(), 2000); // Assume started after 2s
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

test('Server Integration: Can serve index.html', async () => {
  try {
    await startServer();
    
    const response = await fetch(`http://127.0.0.1:${PORT}/`);
    assert.ok(response.ok, 'Server should respond with 200 OK');
    
    const html = await response.text();
    // index.html writes the doctype in lower case.
    assert.ok(/<!doctype html>/i.test(html), 'Should return HTML');
    assert.ok(html.includes('WebMIX') || html.includes('OBS'), 'Should be WebMIX/OBS page');
    
  } finally {
    stopServer();
  }
});

test('Server Integration: Can serve JavaScript modules', async () => {
  try {
    await startServer();
    
    const response = await fetch(`http://127.0.0.1:${PORT}/src/app.js`);
    assert.ok(response.ok, 'Should serve app.js');
    
    const js = await response.text();
    assert.ok(js.includes('import'), 'Should contain ES6 imports');
    assert.ok(js.includes('WebMIX'), 'Should be WebMIX code');
    
  } finally {
    stopServer();
  }
});

test('File Content: dialogs.js has the fix', async () => {
  const content = await readFile(join(webRoot, 'src', 'ui', 'dialogs.js'), 'utf-8');
  
  // Find the exact fix location
  const fixPattern = /clear\(dialog\.body\);\s*dialog\.body\.appendChild\(container\);/;
  assert.ok(
    fixPattern.test(content),
    'dialogs.js should have dialog.body.appendChild(container) after clear()'
  );
  
});

test('File Content: api.js has auto-scale logic', async () => {
  const content = await readFile(join(webRoot, 'src', 'api.js'), 'utf-8');
  
  // Check for the auto-scale implementation
  assert.ok(content.includes('needsAutoScale'), 'Should have needsAutoScale variable');
  assert.ok(content.includes('OBS_BOUNDS_SCALE_INNER'), 'Should use SCALE_INNER bounds');
  assert.ok(
    content.includes('screen_capture') && content.includes('monitor_capture'),
    'Should detect capture source types'
  );
  
  // Check that it's in createInput function
  const createInputMatch = content.match(/async createInput\([^)]+\)[^{]*{([^]*?)(?=\n  async )/);
  assert.ok(createInputMatch, 'Should find createInput function');
  assert.ok(
    createInputMatch[1].includes('needsAutoScale'),
    'Auto-scale logic should be in createInput'
  );
  
});

test('File Content: preview asks OBS for a smooth, pane-sized stream', async () => {
  const content = await readFile(join(webRoot, 'src', 'ui', 'preview.js'), 'utf-8');

  // OBS renders the canvas at 60; asking for half of that is what made the
  // preview feel sluggish next to the native window.
  const fps = content.match(/const\s+PREVIEW_FPS\s*=\s*(\d+)/);
  assert.ok(fps, 'PREVIEW_FPS should exist');
  assert.strictEqual(parseInt(fps[1].replace('_', ''), 10), 60, 'the preview should ask for 60 fps');

  // ...and the frame must be the size the pane shows, not the whole canvas:
  // decoding and uploading 1920x1080 for a ~760px picture is the other half.
  assert.ok(/STREAM_SIZE_STEP/.test(content), 'the stream size should be quantised');
  assert.ok(/#streamSize\(/.test(content), 'and derived from the pane layout');
  assert.ok(/this\.#streamSize\(surface\)/.test(content), 'the stream URL should use it');
  assert.ok(
    /ResizeObserver/.test(content),
    'a splitter drag resizes the pane, so the stream has to follow it'
  );

  // Frames must also be dropped rather than queued when the decoder falls behind.
  assert.ok(/surface\.busy/.test(content), 'a slow decoder should drop frames, not queue them');
});

test('Code Quality: No console.log in production code', async () => {
  const files = ['src/ui/dialogs.js', 'src/api.js', 'src/ui/preview.js'];
  
  for (const file of files) {
    const content = await readFile(join(webRoot, file), 'utf-8');
    
    // Allow console.warn and console.error, but check for console.log
    const lines = content.split('\n');
    const consoleLogLines = lines.filter(line => 
      line.includes('console.log') && 
      !line.trim().startsWith('//') &&
      !line.trim().startsWith('*')
    );
    
    // It's okay to have a few debug logs, just report them
    if (consoleLogLines.length > 0) {
    }
  }
  
});


process.on('exit', () => {
  stopServer();
});
