/**
 * 결 온라인 서버 실행:
 *   npm start               → http://0.0.0.0:8787 (웹 앱 + /ws)
 * 환경 변수: PORT, HOST, DB_PATH(SQLite), STATIC(웹 앱 폴더)
 */
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from './server';

const here = fileURLToPath(new URL('.', import.meta.url));
const staticDir = process.env.STATIC ?? `${here}../../../apps/web/dist`;
// AI 플레이어용 모델: 빌드된 웹 앱 폴더에 있으면 그것을, 없으면 public 폴더를 쓴다. AI_DIR=off 면 봇 없음
const aiDir =
  process.env.AI_DIR === 'off'
    ? null
    : process.env.AI_DIR ?? [staticDir, `${here}../../../apps/web/public`].find((d) => existsSync(`${d}/model/model.onnx`)) ?? null;
if (process.env.STORAGE && process.env.STORAGE !== 'sqlite') throw new Error('Only STORAGE=sqlite is supported. Import legacy JSON before starting.');
if (process.env.DATA && !process.env.DB_PATH) throw new Error('Legacy DATA is set. Import JSON with db:import-json and set DB_PATH.');
const server = createServer({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? `${here}../data/gyeol.sqlite`,
  maintenance: () => existsSync(process.env.MAINTENANCE_FILE ?? `${here}../data/maintenance`),
  staticDir,
  aiDir,
  botWaitMs: Number(process.env.BOT_WAIT_SECONDS ?? 8) * 1000,
  accountLimit: { count: Number(process.env.NEW_ACCOUNTS_PER_HOUR ?? 10), windowMs: 60 * 60 * 1000 },
});

const port = await server.listen().catch(async error => { await server.close().catch(() => undefined); throw error; });
const lan = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal)
  .map((n) => `http://${n!.address}:${port}`);
console.log(`AI 플레이어: ${server.botCount ? `${server.botCount}명 (사람 상대를 ${process.env.BOT_WAIT_SECONDS ?? 8}초 못 찾으면 매칭)` : '꺼짐'}`);
console.log(`결 서버 실행 중\n  이 PC:   http://localhost:${port}\n  같은 와이파이: ${lan.join('  ')}`);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
