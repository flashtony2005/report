import 'virtual:uno.css'
import './assets/main.css'
import './theme/brand.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import { getBackendConfig } from './config/backend'
import { createHttpRepository } from './repository/http-repo'
import { useDesignerStore } from './design/stores/designer'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)

// 后端对接：仅当配置了 VITE_OPENPRINT_API_BASE 才切云端模板仓库。
// 数据源 provider 由 dataSource store 自行按配置/持久化解析（ERP 已配 → 默认 ERP；
// 否则示例数据），未配置后端时全链路本地可用（主任铁律：无后端全链路可用）。
const backend = getBackendConfig()
if (backend) {
  const designerStore = useDesignerStore(pinia)
  designerStore.setRepository(createHttpRepository(backend.options), 'cloud')
}

app.mount('#app')
