import { expect, test } from 'vitest';
import { normalizeNetworkValue } from '../src';

test('WASM tanh의 미세한 끝점 오차는 보정하고 잘못된 모델 출력은 거부한다', () => {
  expect(normalizeNetworkValue(-1.0000001192092896)).toBe(-1);
  expect(normalizeNetworkValue(1.0000001192092896)).toBe(1);
  expect(normalizeNetworkValue(0.73)).toBe(0.73);
  for (const value of [NaN, Infinity, -Infinity, 1.001, -1.001]) expect(() => normalizeNetworkValue(value)).toThrow('Invalid network value');
});
