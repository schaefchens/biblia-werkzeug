/**
 * Git im Inhaltsordner.
 *
 * Zwei Dinge hängen daran: dass die Änderungsübersicht vor einer
 * Veröffentlichung wirklich die Inhalte zeigt und nicht das Werkzeug, und
 * dass der Veröffentlichungstoken verfällt, sobald sich etwas ändert —
 * auch etwas, das Git noch gar nicht kennt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  PUBLISH_PATHS,
  existingPublishPaths,
  parsePorcelainZ,
  homeStatus,
  workspaceFingerprint,
  contentFingerprint,
} from './git-home.mjs';

const gitVorhanden = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, stdio: 'ignore' });

/** Ein kleiner Inhaltsordner im temporären Verzeichnis. */
function inhaltsordner() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'biblia-githome-')));
  fs.mkdirSync(path.join(root, 'content', 'flyers', '101-hoffnung'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'site.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'content', 'flyers', '101-hoffnung', 'flyer.md'), '---\nid: 101\n---\n');
  return {
    root,
    content: path.join(root, 'content'),
    config: path.join(root, 'config'),
    i18n: path.join(root, 'i18n'),
    themeCss: path.join(root, 'theme.css'),
  };
}

function alsRepository(home) {
  git(home.root, 'init', '-q');
  git(home.root, 'config', 'user.email', 'test@beispiel.test');
  git(home.root, 'config', 'user.name', 'Test');
  git(home.root, 'add', '-A');
  git(home.root, 'commit', '-q', '-m', 'erster Stand');
  return home;
}

test('Freiwillige Pfade, die es nicht gibt, fallen aus der Liste', () => {
  const home = inhaltsordner();
  const vorhanden = existingPublishPaths(home);
  // i18n/ und theme.css sind ausdrücklich freiwillig. Bleiben sie in der
  // Liste, bricht "git add" ab und es wird nichts gesichert.
  assert.ok(!vorhanden.includes('i18n'));
  assert.ok(!vorhanden.includes('theme.css'));
  assert.ok(vorhanden.includes('content'));
  assert.ok(vorhanden.includes('config'));
  assert.ok(PUBLISH_PATHS.every((p) => typeof p === 'string'));
});

test('Das Werkzeug steht nie in der Liste der Pfade', () => {
  assert.ok(!PUBLISH_PATHS.includes('werkzeug'));
});

test('Der Parser übersteht Umlaute im Dateinamen', () => {
  const ausgabe = ' M content/flyers/101-groesse/flyer.md\0?? content/flyers/102-üben/flyer.md\0';
  assert.deepEqual(parsePorcelainZ(ausgabe), [
    { code: ' M', path: 'content/flyers/101-groesse/flyer.md', from: null },
    { code: '??', path: 'content/flyers/102-üben/flyer.md', from: null },
  ]);
});

test('Bei einer Umbenennung wird der alte Pfad mitgelesen', () => {
  const ausgabe = 'R  content/flyers/101-neu/flyer.md\0content/flyers/101-alt/flyer.md\0 M config/site.json\0';
  assert.deepEqual(parsePorcelainZ(ausgabe), [
    { code: 'R ', path: 'content/flyers/101-neu/flyer.md', from: 'content/flyers/101-alt/flyer.md' },
    { code: ' M', path: 'config/site.json', from: null },
  ]);
});

test('Ohne Repository wird das gesagt, statt etwas zu behaupten', () => {
  const home = inhaltsordner();
  const status = homeStatus(home);
  assert.equal(status.isRepo, false);
  assert.deepEqual(status.entries, []);
  // Der Fingerabdruck fällt auf den Dateibaum zurück und bleibt brauchbar.
  assert.equal(workspaceFingerprint(home), contentFingerprint(home));
});

test('Eine geänderte verfolgte Datei ändert den Fingerabdruck', { skip: !gitVorhanden }, () => {
  const home = alsRepository(inhaltsordner());
  const vorher = workspaceFingerprint(home);
  fs.writeFileSync(path.join(home.content, 'flyers', '101-hoffnung', 'flyer.md'), '---\nid: 101\nstatus: published\n---\n');
  assert.notEqual(workspaceFingerprint(home), vorher);
});

test('Eine geänderte unverfolgte Datei ändert den Fingerabdruck', { skip: !gitVorhanden }, () => {
  const home = alsRepository(inhaltsordner());
  const neu = path.join(home.content, 'flyers', '101-hoffnung', 'flyer.de.pdf');
  fs.writeFileSync(neu, '%PDF-1.4 erste Fassung\n');
  const vorher = workspaceFingerprint(home);

  // Austauschen, ohne dass Git die Datei je gesehen hat: genau der Fall, den
  // ein Diff nicht bemerkt.
  fs.writeFileSync(neu, '%PDF-1.4 andere Fassung\n');
  assert.notEqual(workspaceFingerprint(home), vorher);
});

test('Ein schmutziges Werkzeug lässt den Fingerabdruck unberührt', { skip: !gitVorhanden }, () => {
  const home = alsRepository(inhaltsordner());
  const werkzeug = path.join(home.root, 'werkzeug');
  fs.mkdirSync(werkzeug);
  git(werkzeug, 'init', '-q');
  fs.writeFileSync(path.join(werkzeug, 'egal.txt'), 'a\n');

  const vorher = workspaceFingerprint(home);
  fs.writeFileSync(path.join(werkzeug, 'egal.txt'), 'b\n');
  assert.equal(workspaceFingerprint(home), vorher, 'das Werkzeug gehört nicht in die Veröffentlichung der Inhalte');

  assert.ok(
    !homeStatus(home).entries.some((e) => e.path.startsWith('werkzeug')),
    'werkzeug/ darf nicht in der Änderungsübersicht stehen',
  );
});

test('Die Zieladresse gehört zum Fingerabdruck', { skip: !gitVorhanden }, () => {
  const home = alsRepository(inhaltsordner());
  assert.notEqual(
    workspaceFingerprint(home, { baseUrl: 'https://a.test/' }),
    workspaceFingerprint(home, { baseUrl: 'https://b.test/' }),
  );
});

test('Derselbe Zustand ergibt denselben Fingerabdruck', { skip: !gitVorhanden }, () => {
  const home = alsRepository(inhaltsordner());
  assert.equal(workspaceFingerprint(home), workspaceFingerprint(home));
});
