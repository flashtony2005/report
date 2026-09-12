import { execSync } from 'node:child_process'

const ps = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'msedge.exe' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
const out = execSync('powershell -NoProfile -Command ' + JSON.stringify(ps), { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 })
const raw = JSON.parse(out || '[]')
const list = Array.isArray(raw) ? raw : [raw]
const rows = []
for (const p of list) {
  const cl = String(p.CommandLine || '')
  let kind = 'node?'
  if (cl.includes('vite/bin/vite.js')) kind = 'VITE'
  else if (cl.includes('vitest')) kind = 'VITEST'
  else if (cl.toLowerCase().includes('msedge')) kind = 'EDGE'
  rows.push(p.ProcessId + '\t' + kind + '\t' + cl.slice(0, 120))
}
console.log(rows.join('\n'))
console.log('total:', list.length)
