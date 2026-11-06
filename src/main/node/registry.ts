import type { AppInfo, StartupItem } from '../../shared/types'
import { parseArray, runPs } from './ps'

const APPS_PS = String.raw`
$paths = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$rows = @()
foreach ($p in $paths) {
  foreach ($i in (Get-ItemProperty $p)) {
    if (-not $i.DisplayName) { continue }
    $scope = 'machine'
    $arch = '64'
    if ($i.PSPath -like '*HKEY_CURRENT_USER*') { $scope = 'user' }
    if ($i.PSPath -like '*WOW6432Node*') { $arch = '32' }
    $rows += [pscustomobject]@{
      name            = [string]$i.DisplayName
      version         = [string]$i.DisplayVersion
      publisher       = [string]$i.Publisher
      installLocation = [string]$i.InstallLocation
      sizeKB          = [int]$i.EstimatedSize
      installDate     = [string]$i.InstallDate
      systemComponent = [int]$i.SystemComponent
      scope           = $scope
      arch            = $arch
      urlInfoAbout    = [string]$i.URLInfoAbout
      installSource   = [string]$i.InstallSource
    }
  }
}
# Dedupe by name keeps the first row, so sort rows that have URLInfoAbout first:
# A4 verification connects to that URL directly, do not lose it in dedupe.
$rows = $rows | Sort-Object @{ Expression = { if ($_.urlInfoAbout) { 0 } else { 1 } } }, name
$rows = $rows | Sort-Object name -Unique
if ($rows.Count -eq 0) { [IO.File]::WriteAllText($Out, '[]', [Text.UTF8Encoding]::new($false)) }
else { [IO.File]::WriteAllText($Out, ($rows | ConvertTo-Json -Depth 3 -Compress), [Text.UTF8Encoding]::new($false)) }
`

/**
 * 按 DisplayName **精确**解析卸载入口（不走 -Unique 去重，多版本/多位数会全部返回）。
 * 卸载工具只认这一份解析结果：卡片展示和实际执行都用它，避免"批准 A、执行 B"。
 */
const RESOLVE_PS = String.raw`
$paths = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$rows = @()
foreach ($p in $paths) {
  foreach ($i in (Get-ItemProperty $p)) {
    if (-not $i.DisplayName) { continue }
    if (([string]$i.DisplayName).Trim() -ne $P1) { continue }
    $scope = 'machine'
    $arch = '64'
    if ($i.PSPath -like '*HKEY_CURRENT_USER*') { $scope = 'user' }
    if ($i.PSPath -like '*WOW6432Node*') { $arch = '32' }
    $rows += [pscustomobject]@{
      name               = ([string]$i.DisplayName).Trim()
      version            = [string]$i.DisplayVersion
      publisher          = [string]$i.Publisher
      installLocation    = [string]$i.InstallLocation
      uninstallString    = [string]$i.UninstallString
      quietUninstallString = [string]$i.QuietUninstallString
      urlInfoAbout       = [string]$i.URLInfoAbout
      installSource      = [string]$i.InstallSource
      systemComponent    = [int]$i.SystemComponent
      scope              = $scope
      arch               = $arch
      key                = [string]$i.PSChildName
    }
  }
}
if ($rows.Count -eq 0) { [IO.File]::WriteAllText($Out, '[]', [Text.UTF8Encoding]::new($false)) }
else { [IO.File]::WriteAllText($Out, ($rows | ConvertTo-Json -Depth 3 -Compress), [Text.UTF8Encoding]::new($false)) }
`

const STARTUP_PS = String.raw`
$rows = @()
$keys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce'
)
foreach ($k in $keys) {
  $item = Get-ItemProperty $k
  if (-not $item) { continue }
  foreach ($p in $item.PSObject.Properties) {
    if ($p.Name -like 'PS*') { continue }
    $rows += [pscustomobject]@{ name = [string]$p.Name; command = [string]$p.Value; source = $k; kind = 'registry'; enabled = $true }
  }
}
$folders = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Startup')
)
foreach ($f in $folders) {
  foreach ($file in (Get-ChildItem -LiteralPath $f -File)) {
    $rows += [pscustomobject]@{ name = $file.BaseName; command = $file.FullName; source = $f; kind = 'startup-folder'; enabled = $true }
  }
}
foreach ($t in (Get-ScheduledTask)) {
  if ($t.State -eq 'Disabled') { continue }
  if ($t.TaskPath -like '\Microsoft\*') { continue }
  $cmd = ($t.Actions | ForEach-Object { ($_.Execute + ' ' + $_.Arguments) }) -join '; '
  $rows += [pscustomobject]@{ name = [string]$t.TaskName; command = $cmd; source = ([string]$t.TaskPath); kind = 'scheduled-task'; enabled = $true }
}
if ($rows.Count -eq 0) { [IO.File]::WriteAllText($Out, '[]', [Text.UTF8Encoding]::new($false)) }
else { [IO.File]::WriteAllText($Out, ($rows | ConvertTo-Json -Depth 3 -Compress), [Text.UTF8Encoding]::new($false)) }
`

interface CacheSlot<T> {
  at: number
  value: T
}

let appsCache: CacheSlot<AppInfo[]> | null = null
let startupCache: CacheSlot<StartupItem[]> | null = null
const APPS_TTL = 5 * 60 * 1000
const STARTUP_TTL = 60 * 1000

export async function listInstalledApps(force = false): Promise<{ apps: AppInfo[]; durationMs: number }> {
  const now = Date.now()
  if (!force && appsCache && now - appsCache.at < APPS_TTL) {
    return { apps: appsCache.value, durationMs: 0 }
  }
  const started = Date.now()
  const apps = parseArray<AppInfo>(await runPs(APPS_PS)).map((a) => ({
    ...a,
    name: (a.name || '').trim(),
    version: a.version || '',
    publisher: a.publisher || '',
    installLocation: a.installLocation || '',
    urlInfoAbout: (a.urlInfoAbout || '').trim(),
    installSource: (a.installSource || '').trim()
  }))
  appsCache = { at: Date.now(), value: apps }
  return { apps, durationMs: Date.now() - started }
}

/** 一条可卸载的注册表记录（字段全部来自注册表原值，不加工） */
export interface UninstallEntry {
  name: string
  version: string
  publisher: string
  installLocation: string
  uninstallString: string
  quietUninstallString: string
  urlInfoAbout: string
  installSource: string
  systemComponent: number
  scope: 'machine' | 'user'
  arch: '32' | '64'
  /** 注册表子键名，用于说明"动的是哪一条" */
  key: string
}

/** 按名称精确解析卸载项；不做缓存，卸载前必须拿到当下这一份 */
export async function resolveUninstallEntries(name: string): Promise<UninstallEntry[]> {
  const target = name.trim()
  if (!target) return []
  const rows = parseArray<UninstallEntry>(await runPs(RESOLVE_PS, [target]))
  return rows.map((row) => ({
    name: String(row.name ?? '').trim(),
    version: String(row.version ?? ''),
    publisher: String(row.publisher ?? ''),
    installLocation: String(row.installLocation ?? ''),
    uninstallString: String(row.uninstallString ?? ''),
    quietUninstallString: String(row.quietUninstallString ?? ''),
    urlInfoAbout: String(row.urlInfoAbout ?? ''),
    installSource: String(row.installSource ?? ''),
    systemComponent: Number(row.systemComponent ?? 0),
    scope: row.scope === 'user' ? 'user' : 'machine',
    arch: row.arch === '32' ? '32' : '64',
    key: String(row.key ?? '')
  }))
}

export async function listStartupItems(force = false): Promise<{ items: StartupItem[]; durationMs: number }> {
  const now = Date.now()
  if (!force && startupCache && now - startupCache.at < STARTUP_TTL) {
    return { items: startupCache.value, durationMs: 0 }
  }
  const started = Date.now()
  const items = parseArray<StartupItem>(await runPs(STARTUP_PS))
  startupCache = { at: Date.now(), value: items }
  return { items, durationMs: Date.now() - started }
}
