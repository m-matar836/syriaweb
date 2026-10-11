'use strict';

// Regression coverage for report drafts: they must be durable across an app
// close/reopen, scoped to the signed-in user, and safely restored into every
// report section without sending incomplete drafts to Google Sheets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const reports = fs.readFileSync(path.join(ROOT, 'page-reports.js'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');

test('report draft is saved in persistent localStorage with a separate owner-scoped timestamp', () => {
  assert.match(reports, /localStorage\.setItem\(formStateKey\(\), JSON\.stringify\(getFormState\(\)\)\)/);
  assert.match(reports, /localStorage\.setItem\(formStateSavedAtKey\(\), String\(Date\.now\(\)\)\)/);
  assert.match(reports, /const formStateSavedAtKey = \(\) => ownerScopedKey\('reportFormLastStateSavedAt'\)/);
  assert.match(core, /const formStateKey = \(\) => ownerScopedKey\('reportFormLastState'\)/);
});

test('draft saving is suppressed while initial controls or saved values are being restored', () => {
  assert.match(reports, /if \(!isFormDirty \|\| stateRestoring \|\| isFormInitializing\) return/);
  assert.match(reports, /isFormInitializing = false;\s*isFormDirty = false/);
});

test('draft records and restores supervisor, date, times, notes and GPS fields', () => {
  assert.match(reports, /supervisor: supervisorInput\?\.value \|\| ''/);
  assert.match(reports, /state\.supervisor !== undefined\) supervisorInput\.value = state\.supervisor \|\| ''/);
  for (const field of ['date', 'timeFrom', 'timeTo', 'notes', 'latitude', 'longitude']) {
    assert.ok(reports.includes(`${field}: document.getElementById`) || reports.includes(`state.${field} || ''`),
      `draft should save and restore ${field}`);
  }
});

test('the exact selected people and all three transaction tables are restored', () => {
  assert.match(reports, /Array\.isArray\(state\.promoters\)\s*\?\s*state\.promoters/);
  assert.match(reports, /if \(Array\.isArray\(state\.sales\)\) state\.sales\.forEach\(createSaleRow\)/);
  assert.match(reports, /state\.salesOfCompetitor\.forEach\(createCompetitorSaleRow\)/);
  assert.match(reports, /if \(Array\.isArray\(state\.expenses\)\) state\.expenses\.forEach\(createExpenseRow\)/);
});

test('app shutdown and backgrounding flush the current draft without blocking close', () => {
  assert.match(reports, /window\.addEventListener\('beforeunload', persistDraftOnExit\)/);
  assert.match(reports, /window\.addEventListener\('pagehide', persistDraftOnExit\)/);
  assert.match(reports, /window\.addEventListener\('freeze', persistDraftOnExit\)/);
  assert.match(reports, /document\.addEventListener\('visibilitychange',[\s\S]{0,200}persistDraftOnExit\(\)/);
  assert.doesNotMatch(reports, /beforeunload',\s*\(event\)\s*=>\s*\{\s*if \(isFormDirty\)\s*\{\s*event\.preventDefault\(\)/);
});

test('corrupt local draft is caught and cleared instead of breaking report screen startup', () => {
  assert.match(reports, /state = JSON\.parse\(savedState\);[\s\S]{0,220}throw new Error\('صيغة المسودة غير صالحة'\)/);
  assert.match(reports, /catch \(error\) \{[\s\S]{0,180}clearFormDraft\(\)/);
});

test('clearing a sent draft also clears its timestamp, while failed submit leaves draft intact', () => {
  assert.match(reports, /const clearFormDraft = \(\) => \{[\s\S]{0,180}localStorage\.removeItem\(formStateSavedAtKey\(\)\)/);
  assert.match(reports, /if \(!resetAfterSubmitSuccess\) \{[\s\S]{0,220}saveFormState\(\);\s*return;/);
});

test('service worker cache is versioned for the new durable-draft code', () => {
  assert.match(sw, /festival-app-v82-report-draft-persistence/);
  assert.ok(sw.includes("'./page-reports.js'"), 'report module remains in the app shell');
});
