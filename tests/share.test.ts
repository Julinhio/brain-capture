import { describe, expect, it } from 'vitest';
import { sharedToCapture } from '../src/shared/share.js';

describe('sharedToCapture', () => {
  it('Chrome: url plus page title', () => {
    expect(sharedToCapture({ title: 'Automation Lead - Qonto', url: 'https://jobs.qonto.com/automation-lead' })).toEqual({
      kind: 'link',
      url: 'https://jobs.qonto.com/automation-lead',
      text: 'Automation Lead - Qonto',
    });
  });

  it('LinkedIn: the link is inside the text', () => {
    expect(
      sharedToCapture({
        text: 'Check out this job at Alan: Internal Tools PM https://www.linkedin.com/jobs/view/4012345678',
      }),
    ).toEqual({
      kind: 'link',
      url: 'https://www.linkedin.com/jobs/view/4012345678',
      text: 'Check out this job at Alan: Internal Tools PM',
    });
  });

  it('plain text without any link becomes a note', () => {
    expect(sharedToCapture({ text: 'Call the dentist on Monday' })).toEqual({ kind: 'text', text: 'Call the dentist on Monday' });
  });

  it('does not repeat identical title and text', () => {
    expect(sharedToCapture({ title: 'Same', text: 'Same' })).toEqual({ kind: 'text', text: 'Same' });
  });

  it('ignores a non-web url field but still finds a link in the text', () => {
    expect(sharedToCapture({ url: 'content://media/1', text: 'see https://alan.com' })).toEqual({
      kind: 'link',
      url: 'https://alan.com/',
      text: 'see',
    });
  });

  it('nothing usable gives nothing', () => {
    expect(sharedToCapture({ title: ' ', text: '' })).toBeNull();
  });
});
