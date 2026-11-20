import type { Player } from '@gyeol/core';
import type { Stage } from './Board';
import { t } from '../i18n';
import { sideName } from '../lib/skins';

/** 지금 무엇을 눌러야 하는지 한 줄로 안내 */
export function stageHint(stage: Stage, player: Player): string {
  if (stage === 'tile') return t('hint.tile', { color: sideName(-player as Player) });
  if (stage === 'dir') return t('hint.dir');
  return t('hint.cell');
}
