/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端基地址，如 https://print.example.com；配置后设计器切云端仓库（§4） */
  readonly VITE_OPENPRINT_API_BASE?: string
  /** 可选：Bearer 鉴权 token */
  readonly VITE_OPENPRINT_API_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
