import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PUBLIC_WEB, serverUrl, webUrl } from '../src/lib/online';

beforeEach(() => {
  vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => false } });
  vi.stubGlobal('location', { protocol: 'https:', host: 'gyeol.example', origin: 'https://gyeol.example' });
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubEnv('VITE_SERVER', '');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test('an APK with no saved server connects to the public Oracle WSS endpoint', () => {
  vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
  vi.stubGlobal('location', { protocol: 'https:', host: 'localhost', origin: 'https://localhost' });
  expect(serverUrl()).toBe('wss://gyeol.146.56.189.166.sslip.io/ws');
});

test('the web continues to use its own origin by default', () => {
  expect(serverUrl()).toBe('wss://gyeol.example/ws');
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:8787' });
  expect(serverUrl()).toBe('ws://127.0.0.1:8787/ws');
});

test('an explicit server or build default retains precedence over the APK default', () => {
  vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
  vi.stubEnv('VITE_SERVER', ' https://preview.example/ ');
  expect(serverUrl('')).toBe('wss://preview.example/ws');
  expect(serverUrl(' 192.168.0.7:8787 ')).toBe('ws://192.168.0.7:8787/ws');
  expect(serverUrl('https://custom.example/path')).toBe('wss://custom.example/ws');
});

test('a whitespace-only build default falls back to Oracle on Android', () => {
  vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
  vi.stubEnv('VITE_SERVER', '   ');
  expect(serverUrl('')).toBe('wss://gyeol.146.56.189.166.sslip.io/ws');
});

test('invite and share links use GitHub Pages except for local or custom servers', () => {
  expect(PUBLIC_WEB).toBe('https://ybs1164.github.io/gyeol/app');
  vi.stubGlobal('location', { protocol: 'https:', host: 'ybs1164.github.io', hostname: 'ybs1164.github.io', href: 'https://ybs1164.github.io/gyeol/app/' });
  expect(webUrl()).toBe(PUBLIC_WEB);
  vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
  vi.stubGlobal('location', { protocol: 'https:', host: 'localhost', hostname: 'localhost', href: 'https://localhost/' });
  expect(webUrl()).toBe(PUBLIC_WEB);
  vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => false } });
  vi.stubGlobal('location', { protocol: 'http:', host: '192.168.0.7:8787', hostname: '192.168.0.7', href: 'http://192.168.0.7:8787/' });
  expect(webUrl()).toBe('http://192.168.0.7:8787');
  vi.stubGlobal('localStorage', { getItem: (k: string) => k === 'gyeol:settings' ? JSON.stringify({ server: '192.168.0.9:8787' }) : null });
  expect(webUrl()).toBe('http://192.168.0.9:8787');
});
