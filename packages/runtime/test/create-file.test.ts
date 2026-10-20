/**
 * `createFile`: the agent writes a small file into its own run's file space
 * and then attaches it with `attachFile`, for a form that demands an upload
 * the task did not provide ("upload your CV", BU Bench V1's "If needed, create
 * a file."). Before this verb a run handed no file could only fail such a form:
 * 14 of 46 misses on BU Bench V1 (2026-10-01, a lab arm, n=100) ended on
 * "this run has no file handling".
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import { runAgent } from '../src/loop';
import type { AgentDeps, RunFile } from '../src/loop';
import { catalogueTree, harness, refOf } from './support';

const page = catalogueTree();
const done: Action = { type: 'done', summary: 'finished' };
const CAPS = { steps: 5, budget: '2.00', duration: '5m' };

/** A file space a test can watch: what was created, and what `list` answers. */
function fileSpace(): {
  readonly files: NonNullable<AgentDeps['files']>;
  readonly created: { readonly name: string; readonly text: string }[];
} {
  const held: RunFile[] = [];
  const created: { readonly name: string; readonly text: string }[] = [];
  return {
    created,
    files: {
      list: () => [...held],
      create(spec) {
        created.push(spec);
        const made = { fileId: `file_made${String(created.length)}`, name: spec.name };
        held.push(made);
        return made;
      },
    },
  };
}

function grammarRows(text: string | undefined): string[] {
  return (text ?? '').split('\n').filter((row) => row.startsWith('  {"type":"'));
}

describe('a run whose host can write files may create one and attach it', () => {
  test('the createFile verb is offered only when the host can create files', async () => {
    const space = fileSpace();
    const able = harness({ model: () => ({ action: done }), tree: page });
    await runAgent({ ...able.deps, files: space.files }, { task: 'apply', caps: CAPS, stepFailures: 0 });
    expect(grammarRows(able.prompts[0]?.text).some((row) => row.startsWith('  {"type":"createFile",'))).toBe(true);
    expect(able.prompts[0]?.canCreateFiles).toBe(true);

    // A host with a manifest and no writer: the verb is not offered, so no
    // step is spent on a file that cannot be made.
    const unable = harness({ model: () => ({ action: done }), tree: page, files: () => [] });
    await runAgent(unable.deps, { task: 'apply', caps: CAPS, stepFailures: 0 });
    expect(unable.prompts[0]?.text).not.toContain('createFile');
    expect(unable.prompts[0]?.canCreateFiles).toBeUndefined();
  });

  test('created, listed by handle on the next step, then attached with that handle', async () => {
    const space = fileSpace();
    const h = harness({
      model: (prompt, step) => {
        if (step === 0) {
          return { action: { type: 'createFile', file: 'resume.txt', text: 'Jane Doe, engineer' } };
        }
        const made = prompt.files?.find((file) => file.name === 'resume.txt');
        return made !== undefined && step === 1
          ? { action: { type: 'attachFile', ref: refOf(page, 'Search'), file: made.fileId } }
          : { action: done };
      },
      perform: () => undefined,
      tree: page,
    });

    const result = await runAgent({ ...h.deps, files: space.files }, { task: 'apply', caps: CAPS, stepFailures: 0 });

    expect(result.status).toBe('completed');
    expect(space.created).toEqual([{ name: 'resume.txt', text: 'Jane Doe, engineer' }]);
    // The next prompt names the new file by handle, which is the only way the
    // model can address it.
    expect(h.prompts[1]?.files).toEqual([{ fileId: 'file_made1', name: 'resume.txt' }]);
    expect(h.prompts[1]?.text).toContain('file_made1');
    // And the handle reaches the page binding through the ordinary attach.
    expect(h.performed).toEqual([{ type: 'attachFile', ref: refOf(page, 'Search'), file: 'file_made1' }]);
    expect(result.steps.map((step) => step.error)).toEqual([undefined, undefined, undefined]);
    // The step record carries the create, as it does every action.
    expect(result.steps[0]?.action).toEqual({ type: 'createFile', file: 'resume.txt', text: 'Jane Doe, engineer' });
  });

  test('a name it cannot render is a step the model reads, and nothing is written', async () => {
    const space = fileSpace();
    const h = harness({
      model: (_prompt, step) =>
        step === 0 ? { action: { type: 'createFile', file: 'payload.exe', text: 'x' } } : { action: done },
      tree: page,
    });

    const result = await runAgent({ ...h.deps, files: space.files }, { task: 'apply', caps: CAPS, stepFailures: 1 });

    expect(result.status).toBe('completed');
    expect(space.created).toEqual([]);
    expect(result.steps[0]?.error).toContain('.txt');
  });

  test('a run whose host cannot write is refused the step by name, uncharged, and the run goes on', async () => {
    const h = harness({
      model: (_prompt, step) =>
        step === 0 ? { action: { type: 'createFile', file: 'cv.pdf', text: 'cv' } } : { action: done },
      tree: page,
      files: () => [],
    });

    // No failure tolerated: a charged failure would end the run on step 0 (dev it-15, 2026-10-14).
    const result = await runAgent(h.deps, { task: 'apply', caps: CAPS, stepFailures: 0 });

    expect(result.status).toBe('completed');
    expect(result.steps[0]?.error).toContain('cannot create files');
    expect(h.performed).toEqual([]);
  });
});

describe('createFile never makes a stand-in for a file the run was given', () => {
  // Outcrawl Bench jobs-apply (fleet 2026-10-20, 3 of 3 dev runs, 1 test run):
  // the task gave a CV by URL, and the run created "cv.pdf" from a sentence
  // and attached it; the site got 582 bytes for a 2,122-byte file.
  const TASK = 'Attach my CV, https://bench.example/files/cv.pdf, and use this cover note: I am keen.';

  const refused = async (options: { readonly file: string; readonly held?: RunFile[]; readonly downloaded?: string }) => {
    const space = fileSpace();
    const h = harness({
      model: (_prompt, step) => (step === 0 ? { action: { type: 'createFile', file: options.file, text: 'Jane Doe CV' } } : { action: done }),
      tree: page,
    });
    const files = { ...space.files, list: async () => [...(options.held ?? []), ...(await space.files.list())] };
    const downloads = options.downloaded === undefined ? [] : [{ id: 'g1', tab: 't0', url: `https://bench.example/files/${options.downloaded}`, filename: options.downloaded }];
    const result = await runAgent({ ...h.deps, files, downloads: () => downloads }, { task: TASK, caps: CAPS, stepFailures: 0 });
    return { result, created: space.created };
  };

  for (const file of ['cv.pdf', 'CV.PDF', 'cv.txt']) {
    test(`a file the task gives by URL (${file}) is refused, uncharged, with the way to the real one`, async () => {
      const { result, created } = await refused({ file });
      expect(created).toEqual([]);
      expect(result.status).toBe('completed');
      expect(result.steps[0]?.error).toContain('"cv.pdf" is a file the task gives by URL');
      expect(result.steps[0]?.error).toContain('Download it in the browser');
    });
  }

  test('a file the run holds is refused and named for attachFile', async () => {
    const { result, created } = await refused({ file: 'certificate.pdf', held: [{ fileId: 'file_dl_g1', name: 'certificate.pdf' }] });
    expect(created).toEqual([]);
    expect(result.steps[0]?.error).toContain('this run already holds');
    expect(result.steps[0]?.error).toContain('"file":"certificate.pdf"');
  });

  test('a file the run is downloading is refused', async () => {
    const { result, created } = await refused({ file: 'compliance.pdf', downloaded: 'compliance.pdf' });
    expect(created).toEqual([]);
    expect(result.steps[0]?.error).toContain('this run downloaded');
  });

  test('a file nothing gave is still made', async () => {
    const { result, created } = await refused({ file: 'cover-note.txt' });
    expect(created).toEqual([{ name: 'cover-note.txt', text: 'Jane Doe CV' }]);
    expect(result.steps[0]?.error).toBeUndefined();
  });
});
