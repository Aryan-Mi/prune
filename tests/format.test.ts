import { expect, test } from 'bun:test';
import { parseCount, replaceCount } from '../src/shared/format.ts';

test('parseCount reads numbers in any locale format', () => {
  expect(parseCount('+751')).toBe(751);
  expect(parseCount('−1,136')).toBe(1136);
  expect(parseCount('-1.136')).toBe(1136);
  expect(parseCount(' (38)')).toBe(38);
  expect(parseCount('1 234 567')).toBe(1234567);
  expect(parseCount('none')).toBeNull();
});

test('replaceCount keeps sign, whitespace and grouping style', () => {
  expect(replaceCount('\n  +751\n ', 40)).toBe('\n  +40\n ');
  expect(replaceCount('−1,136', 1012)).toBe('−1,012');
  expect(replaceCount('1.136', 1012)).toBe('1.012');
  expect(replaceCount('1,136', 12)).toBe('12');
  expect(replaceCount(' (38)', 35)).toBe(' (35)');
  expect(replaceCount('1,234,567', 1234)).toBe('1,234');
});
