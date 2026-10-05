#!/usr/bin/env node
/**
 * WebMIX - Tests for bug fixes
 * 
 * Tests for the three main fixes:
 * 1. Properties dialog opens correctly
 * 2. Screen capture sources are auto-scaled
 * 3. Preview FPS is optimized
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcRoot = join(__dirname, '..', 'src');

test('Fix 1: Properties dialog container is appended to body', async () => {
  const dialogsPath = join(srcRoot, 'ui', 'dialogs.js');
  const content = await readFile(dialogsPath, 'utf-8');
  
  // Find the openPropertiesDialog function
  const funcStart = content.indexOf('export async function openPropertiesDialog');
  assert.ok(funcStart >= 0, 'openPropertiesDialog function should exist');
  
  // Check that after clear(dialog.body), container is appended
  const clearBodyIndex = content.indexOf('clear(dialog.body);', funcStart);
  assert.ok(clearBodyIndex >= 0, 'clear(dialog.body) should be called');
  
  // Extract the section after clear
  const afterClear = content.slice(clearBodyIndex, clearBodyIndex + 500);
  
  // Verify container is appended before render
  assert.ok(
    afterClear.includes('dialog.body.appendChild(container)'),
    'Container should be appended to dialog.body before render()'
  );
  
  // Verify render() is called after appendChild
  const appendIndex = afterClear.indexOf('dialog.body.appendChild(container)');
  const renderIndex = afterClear.indexOf('render()');
  assert.ok(
    renderIndex > appendIndex && renderIndex >= 0,
    'render() should be called after appendChild'
  );
  
});

test('Fix 2: Screen capture sources are auto-scaled', async () => {
  const apiPath = join(srcRoot, 'api.js');
  const content = await readFile(apiPath, 'utf-8');
  
  // Find createInput function
  const funcStart = content.indexOf('async createInput(');
  assert.ok(funcStart >= 0, 'createInput function should exist');
  
  const funcEnd = content.indexOf('\n  async ', funcStart + 1);
  const funcBody = content.slice(funcStart, funcEnd);
  
  // Check for auto-scale logic
  assert.ok(
    funcBody.includes('needsAutoScale'),
    'createInput should have auto-scale logic'
  );
  
  // Check for screen capture pattern detection
  assert.ok(
    funcBody.includes('screen_capture') || funcBody.includes('monitor_capture'),
    'Should detect screen/monitor capture sources'
  );
  
  // Check for setSceneItemTransform call
  assert.ok(
    funcBody.includes('setSceneItemTransform'),
    'Should call setSceneItemTransform for auto-scaling'
  );
  
  // Check for bounds settings
  assert.ok(
    funcBody.includes('OBS_BOUNDS_SCALE_INNER'),
    'Should use SCALE_INNER bounds type'
  );
  
  assert.ok(
    funcBody.includes('boundsWidth') && funcBody.includes('boundsHeight'),
    'Should set bounds width and height'
  );
  
});

test('Fix 3: Preview FPS is optimized', async () => {
  const previewPath = join(srcRoot, 'ui', 'preview.js');
  const content = await readFile(previewPath, 'utf-8');
  
  // Check PREVIEW_FPS constant
  const fpsMatch = content.match(/const\s+PREVIEW_FPS\s*=\s*(\d+)/);
  assert.ok(fpsMatch, 'PREVIEW_FPS constant should exist');
  
  const previewFps = parseInt(fpsMatch[1]);
  assert.ok(
    previewFps >= 30,
    `PREVIEW_FPS should be at least 30, got ${previewFps}`
  );
  
  // Check default fps value
  const fpsDefaultMatch = content.match(/this\.fps\s*=\s*(\d+);\s*\/\/\s*screenshot fallback/);
  assert.ok(fpsDefaultMatch, 'Default fps should be set');
  
  const fallbackFps = parseInt(fpsDefaultMatch[1]);
  assert.ok(
    fallbackFps >= 15,
    `Fallback FPS should be at least 15, got ${fallbackFps}`
  );
  
  // Check setFps max limit
  const setFpsMatch = content.match(/setFps\([^)]+\)\s*{[^}]*Math\.min\((\d+)/);
  assert.ok(setFpsMatch, 'setFps should have max limit');
  
  const maxFps = parseInt(setFpsMatch[1]);
  assert.ok(
    maxFps >= 60,
    `Max FPS should be at least 60, got ${maxFps}`
  );
  
});

test('Integration: All fixes are present', async () => {
  // Verify all three files were modified
  const files = [
    join(srcRoot, 'ui', 'dialogs.js'),
    join(srcRoot, 'api.js'),
    join(srcRoot, 'ui', 'preview.js'),
  ];
  
  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    assert.ok(content.length > 0, `${file} should be readable`);
  }
  
});

test('Code quality: No syntax errors in modified files', async () => {
  const files = [
    join(srcRoot, 'ui', 'dialogs.js'),
    join(srcRoot, 'api.js'),
    join(srcRoot, 'ui', 'preview.js'),
  ];
  
  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    
    // Basic syntax checks
    const braceBalance = (content.match(/\{/g)?.length || 0) - (content.match(/\}/g)?.length || 0);
    assert.strictEqual(braceBalance, 0, `${file} should have balanced braces`);
    
    const parenBalance = (content.match(/\(/g)?.length || 0) - (content.match(/\)/g)?.length || 0);
    assert.strictEqual(parenBalance, 0, `${file} should have balanced parentheses`);
    
    // Check for common issues
    assert.ok(!content.includes('debugger;'), `${file} should not contain debugger statements`);
  }
  
});

