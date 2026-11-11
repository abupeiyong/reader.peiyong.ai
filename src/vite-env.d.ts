/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" = Hadi 小程序的包(vite.hadi.config.ts 注入) */
  readonly VITE_HADI?: string;
  /** 小程序里后端接口和静态资源所在的站点,如 https://reader.peiyong.ai */
  readonly VITE_API_BASE?: string;
}
