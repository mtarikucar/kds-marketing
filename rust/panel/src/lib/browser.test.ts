import { describe, expect, it } from 'vitest';
import { fileUrl } from './browser';

describe('fileUrl', () => {
  it('opens https, and plain http only to this computer', () => {
    expect(fileUrl('https://files.jeeta.example/files/1?sig=a')).toBe('https://files.jeeta.example/files/1?sig=a');
    for (const local of ['http://localhost:8080/files/1', 'http://127.0.0.1:8080/files/1', 'http://[::1]:8080/files/1']) {
      expect(fileUrl(local)).toBe(local);
    }
    for (const refused of [
      'http://files.jeeta.example/files/1',
      'http://localhost.jeeta.example/files/1',
      'javascript:alert(1)',
      '/files/1',
      'ftp://localhost/1',
      'not a url',
    ]) {
      expect(fileUrl(refused)).toBeNull();
    }
  });
});
