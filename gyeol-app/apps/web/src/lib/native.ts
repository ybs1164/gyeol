import { isNative } from './platform';

/** 안드로이드 뒤로 가기: 앱 안 화면 기록이 있으면 뒤로, 홈이면 앱 종료 */
export async function setupNative() {
  if (!isNative()) return;
  const { App } = await import('@capacitor/app');
  App.addListener('backButton', () => {
    if (location.hash && location.hash !== '#' && location.hash !== '#/') history.back();
    else App.exitApp();
  });
}
