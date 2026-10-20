/**
 * A PDF a tab shows is handed to the host to keep as a file of the run, once
 * per document, from the bytes read for its text; and the snapshot's line
 * names the file only when it was kept. Against a fake page: no browser.
 */
import { describe, expect, test } from 'bun:test';

import type { CdpPage } from '../src/cdp';
import { pdfDocuments, pdfNotice, type KeepPdf } from '../src/pdf-document';
import { topFrameWatch } from '../src/top-frame';

const URL_ONE = 'https://standards.example/pubs/final/spec%2046.pdf';

/** A one-page PDF the parser reads, built rather than checked in (scout-core's pdf-text tests build theirs the same way). */
function readablePdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    'STREAM',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const content = 'BT /F1 12 Tf 72 720 Td (Data Encryption Standard) Tj ET';
  const body = objects
    .map((object, index) =>
      object === 'STREAM'
        ? `${String(index + 1)} 0 obj\n<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream\nendobj\n`
        : `${String(index + 1)} 0 obj\n${object}\nendobj\n`,
    )
    .join('');
  return Buffer.from(`%PDF-1.4\n${body}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

/** A tab whose top frame shows a PDF; each read answers the next of `replies` (the last repeats); `navigate` commits another document. */
function pdfTab(...replies: (Uint8Array | 'not-cached')[]) {
  const handlers: ((params: Record<string, unknown>) => void)[] = [];
  let frame = { id: 'F1', url: URL_ONE, mimeType: 'application/pdf', loaderId: 'L1' };
  const page: CdpPage = {
    targetId: 'T1',
    sessionId: 'S1',
    url: () => frame.url,
    sendBrowser: async () => ({}),
    on: (method, handler) => {
      if (method === 'Page.frameNavigated') handlers.push(handler);
      return () => undefined;
    },
    send: async (method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame } };
      if (method === 'Page.getResourceContent') {
        const bytes = replies.length > 1 ? replies.shift() : replies[0];
        if (bytes === undefined || bytes === 'not-cached') throw new Error('Resource was not cached');
        return { content: Buffer.from(bytes).toString('base64'), base64Encoded: true };
      }
      return {};
    },
  };
  const navigate = (loaderId: string): void => {
    frame = { ...frame, loaderId };
    for (const handler of handlers) handler({ frame });
  };
  return { page, navigate };
}

function recordingKeep(answer: string | undefined): { readonly keep: KeepPdf; readonly kept: { url: string; bytes: Uint8Array }[] } {
  const kept: { url: string; bytes: Uint8Array }[] = [];
  return {
    kept,
    keep: (file) => {
      kept.push(file);
      return answer;
    },
  };
}

describe('a PDF in a tab, kept as a file', () => {
  const BYTES = readablePdf();

  test('its bytes are handed over once per document, and the snapshot names the file', async () => {
    const { page, navigate } = pdfTab(BYTES);
    const { keep, kept } = recordingKeep('spec 46.pdf');
    const docs = pdfDocuments(page, topFrameWatch(page), keep);

    expect((await docs.read())?.outcome).toBe('read');
    await docs.read();
    expect((await docs.peek())?.keptAs).toBe('spec 46.pdf');
    expect(kept).toEqual([{ url: URL_ONE, bytes: BYTES }]);

    navigate('L2');
    await docs.read();
    expect(kept).toHaveLength(2);
  });

  test('a read that may be truncated is not kept; the whole file read after it is', async () => {
    const truncated = BYTES.subarray(0, 40);
    const { page } = pdfTab(truncated, BYTES);
    const { keep, kept } = recordingKeep('spec 46.pdf');
    const docs = pdfDocuments(page, topFrameWatch(page), keep);

    expect((await docs.read())?.outcome).toBe('unread');
    expect(kept).toEqual([]);
    expect((await docs.read())?.outcome).toBe('read');
    expect(kept).toEqual([{ url: URL_ONE, bytes: BYTES }]);
  });

  test('a host that does not keep it is not said to have', async () => {
    const { page } = pdfTab(BYTES);
    const { keep, kept } = recordingKeep(undefined);
    const docs = pdfDocuments(page, topFrameWatch(page), keep);
    await docs.read();
    expect(kept).toHaveLength(1);
    expect((await docs.peek())?.keptAs).toBeUndefined();
  });

  test('a PDF the browser kept no copy of is not handed over', async () => {
    const { page } = pdfTab('not-cached');
    const { keep, kept } = recordingKeep('spec 46.pdf');
    const docs = pdfDocuments(page, topFrameWatch(page), keep);
    await docs.read();
    expect(kept).toEqual([]);
    expect((await docs.peek())?.keptAs).toBeUndefined();
  });
});

describe("the snapshot's line for a kept PDF", () => {
  const read = { outcome: 'read', url: URL_ONE, pages: 3, text: 'abc', omittedChars: 0 } as const;

  test('names the file it was kept as, whether its text was read, is unreadable, or is still being read', () => {
    const sentence = ` It is kept with this run's downloads as "spec 46.pdf".`;
    expect(pdfNotice(read, 'spec 46.pdf')).toBe(
      `This tab shows a PDF document: 3 pages, 3 characters of text. Its text is not shown here; {"type":"extract"} reads it.${sentence}`,
    );
    expect(pdfNotice({ outcome: 'unread', url: URL_ONE, why: 'it is encrypted' }, 'spec 46.pdf')).toBe(
      `This tab shows a PDF document, and its text cannot be read: it is encrypted.${sentence}`,
    );
    expect(pdfNotice(undefined, 'spec 46.pdf')).toEndWith(sentence);
  });

  test('says nothing of keeping when it was not kept', () => {
    expect(pdfNotice(read)).not.toContain('kept');
  });
});
