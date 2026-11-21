/**
 * GET /api/puzzles: 서버 생성기(db-cli mine-puzzles)가 만든 은행을 그대로 내려준다.
 * 파일이 바뀌면(mtime·크기) 다시 읽고, 정답이 하나뿐이라는 조건을 저장된 풀이로 다시 확인한 문제만 보낸다.
 * 앱(안드로이드 https://localhost)이 다른 출처에서 읽으므로 공개 데이터인 이 경로만 CORS를 연다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { PUZZLE_BANK_SCHEMA, uniqueProofProblem, type PuzzleBankFile } from '@gyeol/core';

interface Cached { stamp: string; etag: string; body: Buffer; gzip: Buffer; count: number }

export function puzzleBankRoute(file: string | null) {
  let cached: Cached | null = null;
  const load = (): Cached | null => {
    if (!file || !existsSync(file)) return null;
    const st = statSync(file);
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (cached?.stamp === stamp) return cached;
    const bank = JSON.parse(readFileSync(file, 'utf8')) as PuzzleBankFile;
    if (bank.schema !== PUZZLE_BANK_SCHEMA || !Array.isArray(bank.puzzles)) throw new Error('Unknown puzzle bank schema');
    const puzzles = bank.puzzles.filter((p) => !uniqueProofProblem(p));
    if (!puzzles.length) return null;
    const body = Buffer.from(JSON.stringify(puzzles.length === bank.puzzles.length ? bank : { ...bank, puzzles }));
    cached = { stamp, etag: `"${bank.version}-${puzzles.length}"`, body, gzip: gzipSync(body), count: puzzles.length };
    return cached;
  };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' };

  /** 이 경로를 처리했으면 true */
  return function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/api/puzzles') return false;
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, cors); res.end(); return true; }
    let bank: Cached | null;
    try { bank = load(); } catch { bank = null; }
    if (!bank) {
      res.writeHead(503, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '600' });
      res.end(JSON.stringify({ ok: false, code: 'puzzles_unavailable' }));
      return true;
    }
    const headers = { ...cors, etag: bank.etag, 'cache-control': 'no-cache', vary: 'accept-encoding' };
    if (req.headers['if-none-match'] === bank.etag) { res.writeHead(304, headers); res.end(); return true; }
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const body = gzip ? bank.gzip : bank.body;
    res.writeHead(200, { ...headers, 'content-type': 'application/json', 'content-length': body.length, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
