import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.ybs1164.gyeol',
  appName: '결',
  webDir: 'dist',
  // 기기 안의 파일을 https://localhost 로 제공. 같은 와이파이의 PC 서버(ws://)에 붙을 수 있게 혼합 콘텐츠를 허용
  server: { androidScheme: 'https', cleartext: true },
  android: {
    allowMixedContent: true,
    backgroundColor: '#1c1b1a',
  },
};

export default config;
