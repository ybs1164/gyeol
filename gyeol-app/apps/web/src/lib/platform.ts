/**
 * 이 기기에서 쓸 수 있는 기능. 화면 곳곳에서 navigator · Capacitor 를 직접 검사하지 않고 여기서 본다.
 * 같은 코드가 데스크톱 브라우저, 휴대폰 브라우저(PWA), 안드로이드 앱에서 돈다.
 */

type CapacitorWindow = { Capacitor?: { isNativePlatform?: () => boolean } };

/** 안드로이드 앱(Capacitor) 안인가 */
export const isNative = (): boolean => (window as CapacitorWindow).Capacitor?.isNativePlatform?.() === true;

/**
 * 진동을 쓸 수 있는가: API 가 있고 손에 드는 터치 기기일 때.
 * 데스크톱 크롬에도 navigator.vibrate 는 있지만 아무 일도 하지 않고, iOS 사파리에는 API 가 없다
 */
export const canVibrate = (): boolean =>
  typeof navigator.vibrate === 'function' && (isNative() || window.matchMedia?.('(pointer: coarse)').matches === true);

export function vibrate(ms: number): void {
  if (!canVibrate()) return;
  try {
    navigator.vibrate(ms);
  } catch {
    /* 막힌 기기 — 무시 */
  }
}

/** 기기의 공유 창이 있는가 (휴대폰 브라우저 · 일부 데스크톱) */
export const canShare = (): boolean => typeof navigator.share === 'function';

/**
 * 클립보드에 복사. 같은 와이파이의 http 주소처럼 보안 연결이 아니면 navigator.clipboard 가 없으므로
 * 숨긴 입력 칸을 고르고 복사하는 예전 방식으로 한 번 더 시도한다
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 아래 방식으로 */
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 공유 창이 있으면 공유, 없거나 실패하면 복사. 사용자가 공유 창을 닫으면 'cancelled' */
export async function shareText(text: string): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  if (canShare()) {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    }
  }
  return (await copyText(text)) ? 'copied' : 'failed';
}
