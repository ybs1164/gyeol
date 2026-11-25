import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ko } from '../src/i18n/ko';
import { en } from '../src/i18n/en';
import { ja } from '../src/i18n/ja';
import { zh } from '../src/i18n/zh';
import { LESSONS, MOVE_TYPES, RATED_KINDS } from '@gyeol/core';
import { ACHIEVEMENTS, GRADES, MOVE_REASONS } from '@gyeol/ai';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('번역', () => {
  const dicts = { en, ja, zh };
  test('모든 언어가 같은 키와 같은 {변수}를 가진다', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    for (const [lang, d] of Object.entries(dicts))
      for (const k of Object.keys(ko) as (keyof typeof ko)[]) {
        expect(d[k], `${lang}:${k}`).toBeTruthy();
        expect(vars(d[k]), `${lang}:${k}`).toBe(vars(ko[k]));
      }
  });

  test('코드에서 쓰는 고정 키가 사전에 모두 있다', () => {
    const missing: string[] = [];
    for (const f of files(SRC)) {
      if (f.includes('i18n')) continue;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\('([\w.]+)'/g)) if (!(m[1] in ko)) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  test('동적 키(레슨, 난이도, 방향, 색, 오류)도 모두 있다', () => {
    const keys = [
      ...GRADES.map(g => `review.${g}`),
      ...GRADES.map(g => `grading.rule.${g}`),
      ...MOVE_REASONS.map(reason => `grading.reason.${reason}`),
      'review.onlyWin', 'review.onlyDefense', 'review.brilliant',
      ...ACHIEVEMENTS.flatMap(a => [`achievement.${a}`, `achievement.help.${a}`]),
      ...[0, 1, 2].map(i => `report.phase.${i}`),
      ...[...MOVE_TYPES, 'best'].flatMap(type => [`type.${type}`, `type.reason.${type}`, `type.help.${type}`]),
      ...['missedWin', 'missedChance', 'missedDefense', 'onlyMove', 'convertedChance', 'estimated', 'stable', 'exact', 'standard', 'deep', 'all', 'mine', 'issues'].map(k => `review.${k}`),
      ...LESSONS.flatMap((l) => [`lesson.${l.id}.title`, `lesson.${l.id}.text`]),
      ...['easy', 'normal', 'hard', 'master'].flatMap((l) => [`level.${l}`, `level.${l}.desc`]),
      ...[0, 1, 2, 3].flatMap((d) => [`dir.${d}`, `dirTo.${d}`]),
      ...['classic', 'teal', 'sea', 'vivid'].flatMap((s) => [`color.${s}.first`, `color.${s}.second`, `skin.${s}`]),
      ...['not_found', 'not_your_turn', 'illegal', 'stale', 'full', 'bad_name', 'finished', 'not_player', 'hello_first', 'bad_request', 'rate_limited'].map((c) => `err.${c}`),
      ...['early', 'repeat', 'provisional'].map((c) => `rating.restriction.${c}`),
      ...['turn.ok', 'capture.ok', 'capture.one', 'capture.none', 'loop.ok', 'loop.no', 'limit.ok', 'pass.ok', 'pass.no'].map((c) => `check.${c}`),
      ...['bullet', 'blitz', 'rapid', 'daily'].flatMap((m) => [`mode.${m}`, `modeName.${m}`]),
      ...['place', 'bronze', 'silver', 'gold', 'plat', 'dia', 'master'].map((x) => `tier.${x}`),
      ...['auto', 'light', 'dark'].map((x) => `set.theme.${x}`),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `stage.${n}`),
      ...RATED_KINDS.map((k) => `kind.${k}`),
      ...['ai', 'online'].map((k) => `rated.source.${k}`),
    ];
    expect(keys.filter((k) => !(k in ko))).toEqual([]);
  });
});
